import { PERMISSIONS, SYSTEM_ROLES, type Auth, type DeviceSignals, type PublicUser } from "@mgpl-diagnostics/auth-kit";
import { ConflictError, createUser, NotFoundError, ValidationError, type Id, type Repositories, type Role, type RoleAssignment, type User } from "@mgpl-diagnostics/db-kit";
import type { Actor } from "../graphql/context";
import type { JobQueue } from "../jobs/types";
import { mustOwn } from "./util";

/** Sends password-reset links. Plug in email/SMS in the container; the API never returns reset tokens. */
export interface Mailer {
  passwordReset(to: { email: string; name: string }, link: string, expiresAt: Date): Promise<void>;
}

const publicUser = ({ passwordHash: _p, ...u }: User): Omit<User, "passwordHash"> => u;

/** Sign-in, sessions and passwords (auth-kit), plus users and roles (db-kit storage). */
export class AuthService {
  constructor(
    private readonly repos: Repositories,
    private readonly auth: Auth,
    private readonly opts: { mailer?: Mailer; resetUrl: string | null; jobs: () => JobQueue },
  ) {}

  // ---------------------------------------------------------------- sessions

  login(input: { email: string; password: string; orgCode?: string | null; ip?: string; userAgent?: string; device?: DeviceSignals; tlsFingerprint?: string }) {
    return this.auth.login({ ...input, orgCode: input.orgCode ?? undefined });
  }

  /** Spends a refresh token: a new access token and the next refresh token (rotation). */
  async refresh(input: { refreshToken: string; ip?: string; userAgent?: string; device?: DeviceSignals; tlsFingerprint?: string }) {
    const p = await this.auth.refresh(input);
    return { token: p.accessToken, expiresAt: p.accessExpiresAt, ...p };
  }

  /** Ends the session of an access token (even expired), or of a refresh token. */
  logout(token: string) {
    return this.auth.logout(token);
  }

  /** Ends every other session of the user (keeps the current one). */
  logoutOthers(actor: Actor, currentToken: string) {
    return this.auth.logoutAll(actor.userId, currentToken);
  }

  sessions(actor: Actor) {
    return this.auth.sessionsOf(actor.userId);
  }

  revokeSession(actor: Actor, sessionId: string) {
    return this.auth.revokeSession(actor.userId, sessionId);
  }

  changePassword(actor: Actor, currentPassword: string, newPassword: string, currentToken?: string) {
    return this.auth.changePassword({ userId: actor.userId, currentPassword, newPassword, currentToken });
  }

  /**
   * Always resolves (never reveals whether the email exists). Queued: the worker (or, without Redis,
   * this process) runs `sendPasswordReset`, so the answer takes the same time for every email.
   */
  requestPasswordReset(input: { email: string; orgCode?: string | null; ip?: string }): Promise<void> {
    return this.opts.jobs().passwordReset({ email: input.email, orgCode: input.orgCode ?? null, ip: input.ip });
  }

  /** The job: creates the single-use token (auth-kit) and mails the link. True when an email went out. */
  async sendPasswordReset(input: { email: string; orgCode?: string | null; ip?: string }): Promise<boolean> {
    const r = await this.auth.requestPasswordReset({ email: input.email, orgCode: input.orgCode ?? undefined, ip: input.ip });
    if (!r) return false;
    if (!this.opts.mailer) {
      console.warn("[auth] no Mailer configured: a password-reset link was not sent");
      return false;
    }
    const base = this.opts.resetUrl ?? "/reset-password";
    await this.opts.mailer.passwordReset({ email: r.user.email, name: r.user.name }, `${base}?token=${encodeURIComponent(r.token)}`, r.expiresAt);
    return true;
  }

  resetPassword(token: string, newPassword: string): Promise<PublicUser> {
    return this.auth.resetPassword({ token, newPassword });
  }

  // ---------------------------------------------------------------- users

  async me(actor: Actor) {
    const u = await this.repos.users.get(actor.userId);
    if (!u) throw new NotFoundError("User", actor.userId);
    return publicUser(u);
  }

  async users(actor: Actor) {
    return (await this.repos.users.find({ orgId: actor.orgId }, { sort: { field: "name" } })).map(publicUser);
  }

  async user(actor: Actor, id: Id) {
    const u = await this.repos.users.get(id);
    return u && u.orgId === actor.orgId ? publicUser(u) : null;
  }

  async createUser(actor: Actor, input: { name: string; email: string; phone?: string | null; password: string; roles: RoleAssignment[] }) {
    await this.assertRoles(actor, input.roles);
    const passwordHash = await this.auth.hashNewPassword(input.password, { email: input.email, name: input.name });
    const u = await createUser(this.repos, { orgId: actor.orgId, name: input.name, email: input.email, phone: input.phone ?? undefined, roles: input.roles, passwordHash }, actor.userId);
    return publicUser(u);
  }

  async setUserRoles(actor: Actor, userId: Id, roles: RoleAssignment[]) {
    mustOwn(await this.repos.users.get(userId), actor.orgId, "User", userId);
    await this.assertRoles(actor, roles);
    const u = await this.repos.users.update(userId, { roles });
    await this.repos.audit.log({ orgId: actor.orgId, userId: actor.userId, action: "user.roles", entity: "user", entityId: userId });
    return publicUser(u!);
  }

  /** Disabling ends every session at once (auth-kit re-reads the user on each request). */
  async setUserStatus(actor: Actor, userId: Id, status: "active" | "disabled") {
    mustOwn(await this.repos.users.get(userId), actor.orgId, "User", userId);
    if (userId === actor.userId && status === "disabled") throw new ConflictError("You cannot disable your own account");
    const u = await this.repos.users.update(userId, { status });
    if (status === "disabled") await this.auth.logoutAll(userId);
    await this.repos.audit.log({ orgId: actor.orgId, userId: actor.userId, action: `user.${status === "disabled" ? "disable" : "enable"}`, entity: "user", entityId: userId });
    return publicUser(u!);
  }

  async setUserPassword(actor: Actor, userId: Id, newPassword: string) {
    mustOwn(await this.repos.users.get(userId), actor.orgId, "User", userId);
    await this.auth.setPassword(userId, newPassword, actor.userId);
  }

  // ---------------------------------------------------------------- roles

  roles(actor: Actor): Promise<Role[]> {
    return this.repos.roles.find({ orgId: actor.orgId }, { sort: { field: "key" } });
  }

  permissions(): readonly string[] {
    return PERMISSIONS;
  }

  /** Creates or replaces a custom role. System roles (seeded from auth-kit) cannot be changed. */
  async upsertRole(actor: Actor, input: { key: string; name: string; permissions: string[] }) {
    const key = input.key.trim().toLowerCase();
    if (!/^[a-z][a-z0-9_]{1,40}$/.test(key)) throw new ValidationError("Role key: lower-case letters, digits and _");
    for (const p of input.permissions) {
      if (!/^([a-z_]+|\*):([a-z_]+|\*)$/.test(p)) throw new ValidationError(`Invalid permission "${p}"`);
    }
    const existing = await this.repos.roles.findOne({ orgId: actor.orgId, key });
    if (existing?.system) throw new ConflictError(`Role ${key} is a system role`);
    const role = existing
      ? await this.repos.roles.update(existing.id, { name: input.name, permissions: input.permissions })
      : await this.repos.roles.create({ orgId: actor.orgId, key, name: input.name, permissions: input.permissions, system: false });
    this.auth.invalidateRoles(actor.orgId);
    await this.repos.audit.log({ orgId: actor.orgId, userId: actor.userId, action: "role.upsert", entity: "role", entityId: role!.id });
    return role!;
  }

  /** Seeds auth-kit's SYSTEM_ROLES for an organisation that lacks some (idempotent). */
  async ensureSystemRoles(orgId: Id) {
    for (const r of SYSTEM_ROLES) {
      const existing = await this.repos.roles.findOne({ orgId, key: r.key });
      if (existing) await this.repos.roles.update(existing.id, { name: r.name, permissions: r.permissions, system: true });
      else await this.repos.roles.create({ orgId, key: r.key, name: r.name, permissions: r.permissions, system: true });
    }
    this.auth.invalidateRoles(orgId);
  }

  private async assertRoles(actor: Actor, roles: RoleAssignment[]) {
    if (!roles.length) throw new ValidationError("Give the user at least one role");
    const keys = new Set((await this.roles(actor)).map((r) => r.key));
    for (const r of roles) {
      if (!keys.has(r.role)) throw new ValidationError(`Unknown role "${r.role}"`);
      if (r.branchId) mustOwn(await this.repos.branches.get(r.branchId), actor.orgId, "Branch", r.branchId);
    }
  }
}
