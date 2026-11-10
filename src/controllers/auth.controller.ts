import { AuthError } from "@mgpl-diagnostics/auth-kit";
import type { RoleAssignment, User } from "@mgpl-diagnostics/db-kit";
import type { RequestContext as Ctx } from "../graphql/context";
import type { TokenPairLike } from "../graphql/cookies";
import { unauthenticated, withErrorCodes } from "../graphql/errors";
import { actorOf, authorize } from "../graphql/guards";
import { deviceOf, type DeviceInput } from "../graphql/device";

/**
 * Hands new tokens to the client: as httpOnly cookies (and null in the body) for a cookie session, in the
 * body otherwise. A script on the page never reads a cookie session's tokens, not even through refresh.
 */
function deliver<P extends TokenPairLike>(ctx: Ctx, pair: P, asCookies: boolean) {
  const body = { ...pair, token: pair.accessToken, expiresAt: pair.accessExpiresAt };
  if (!asCookies) return body;
  ctx.cookies.set(pair);
  return { ...body, accessToken: null, refreshToken: null, token: null };
}

/** auth-kit: sign-in, sessions, passwords; users and roles. */
export const authController = withErrorCodes({
  Query: {
    viewer: (_: unknown, __: unknown, ctx: Ctx) => (ctx.viewer ? {} : null),
    myOrganizations: (_: unknown, __: unknown, ctx: Ctx) => ctx.services.auth.organizations(actorOf(ctx)),
    mySessions: async (_: unknown, __: unknown, ctx: Ctx) => {
      const sessions = await ctx.services.auth.sessions(actorOf(ctx));
      return sessions.map((s) => ({ ...s, current: s.id === ctx.viewer!.sessionId, createdAt: new Date(s.createdAt), lastSeenAt: new Date(s.lastSeenAt), expiresAt: new Date(s.expiresAt), deviceId: s.device?.deviceId ?? null, deviceInfo: s.device?.info ?? null }));
    },
    users: (_: unknown, __: unknown, ctx: Ctx) => ctx.services.auth.users(authorize(ctx, "user:read")),
    user: (_: unknown, a: { id: string }, ctx: Ctx) => ctx.services.auth.user(authorize(ctx, "user:read"), a.id),
    roles: (_: unknown, __: unknown, ctx: Ctx) => ctx.services.auth.roles(authorize(ctx, "role:read")),
    permissions: (_: unknown, __: unknown, ctx: Ctx) => (actorOf(ctx), ctx.services.auth.permissions()),
  },

  Viewer: {
    user: (_: unknown, __: unknown, ctx: Ctx) => ctx.services.auth.me(actorOf(ctx)),
    organization: (_: unknown, __: unknown, ctx: Ctx) => ctx.services.organization.organization(actorOf(ctx)),
    permissions: (_: unknown, a: { branchId?: string | null }, ctx: Ctx) => ctx.permissions(a.branchId),
    branchesFor: (_: unknown, a: { permission: string }, ctx: Ctx) => {
      const b = ctx.branchesFor(a.permission);
      return b === "all" ? null : b;
    },
    can: (_: unknown, a: { permission: string; branchId?: string | null }, ctx: Ctx) => ctx.can(a.permission, a.branchId),
  },

  RoleAssignment: {
    branch: (r: RoleAssignment, _: unknown, ctx: Ctx) => ctx.loaders.branch.load(r.branchId),
  },

  User: {
    createdAt: (u: User) => u.createdAt,
  },

  Mutation: {
    login: async (_: unknown, { input: { device, ...input } }: { input: { email: string; password: string; orgCode?: string | null; device?: DeviceInput | null } }, ctx: Ctx) => {
      const r = await ctx.services.auth.login({ ...input, ip: ctx.ip, userAgent: ctx.userAgent, device: deviceOf(device), tlsFingerprint: ctx.tlsFingerprint });
      return deliver(ctx, { ...r, accessToken: r.token, accessExpiresAt: r.expiresAt, refreshToken: r.refreshToken!, refreshExpiresAt: r.refreshExpiresAt! }, ctx.cookies.requested);
    },
    switchOrganization: async (_: unknown, a: { orgCode: string; device?: DeviceInput | null }, ctx: Ctx) => {
      if (!ctx.token) throw unauthenticated();
      // the old session ends: a cookie session gets the new one as cookies too
      const asCookies = ctx.tokenSource === "cookie";
      const r = await ctx.services.auth.switchOrganization({ token: ctx.token, orgCode: a.orgCode, ip: ctx.ip, userAgent: ctx.userAgent, device: deviceOf(a.device), tlsFingerprint: ctx.tlsFingerprint });
      return deliver(ctx, { ...r, accessToken: r.token, accessExpiresAt: r.expiresAt, refreshToken: r.refreshToken!, refreshExpiresAt: r.refreshExpiresAt! }, asCookies);
    },
    refreshSession: async (_: unknown, a: { refreshToken?: string | null; device?: DeviceInput | null }, ctx: Ctx) => {
      // a refresh token in the arguments: bearer client, tokens in the body. None: the refresh cookie.
      // A failed cookie refresh leaves the cookies alone: when two refreshes race, the loser must not
      // clear the cookies the winner just set. The client signs out; logout clears them.
      const asCookies = !a.refreshToken;
      const refreshToken = a.refreshToken || ctx.cookies.refresh;
      if (!refreshToken) throw new AuthError("INVALID_TOKEN", "Sign in again");
      const p = await ctx.services.auth.refresh({ refreshToken, ip: ctx.ip, userAgent: ctx.userAgent, device: deviceOf(a.device), tlsFingerprint: ctx.tlsFingerprint });
      return deliver(ctx, p, asCookies);
    },
    logout: async (_: unknown, a: { refreshToken?: string | null }, ctx: Ctx) => {
      // a cookie session ends by its refresh cookie (the access cookie may have expired already)
      const token = a.refreshToken || (ctx.tokenSource === "bearer" ? ctx.token : null) || ctx.cookies.refresh || ctx.token;
      if (ctx.cookies.requested) ctx.cookies.clear();
      if (!token) {
        if (ctx.cookies.requested) return true; // nothing left to end: signing out is idempotent
        throw unauthenticated();
      }
      await ctx.services.auth.logout(token);
      return true;
    },
    logoutOtherSessions: (_: unknown, __: unknown, ctx: Ctx) => ctx.services.auth.logoutOthers(actorOf(ctx), ctx.token!),
    revokeSession: (_: unknown, a: { id: string }, ctx: Ctx) => ctx.services.auth.revokeSession(actorOf(ctx), a.id),
    changePassword: async (_: unknown, a: { currentPassword: string; newPassword: string }, ctx: Ctx) => {
      await ctx.services.auth.changePassword(actorOf(ctx), a.currentPassword, a.newPassword, ctx.token ?? undefined);
      return true;
    },
    requestPasswordReset: async (_: unknown, a: { email: string; orgCode?: string | null }, ctx: Ctx) => {
      await ctx.services.auth.requestPasswordReset({ ...a, ip: ctx.ip });
      return true;
    },
    resetPassword: async (_: unknown, a: { token: string; newPassword: string }, ctx: Ctx) => {
      await ctx.services.auth.resetPassword(a.token, a.newPassword);
      return true;
    },

    createUser: (_: unknown, { input }: { input: { name: string; email: string; phone?: string | null; password: string; roles: RoleAssignment[] } }, ctx: Ctx) =>
      ctx.services.auth.createUser(authorize(ctx, "user:create"), { ...input, roles: input.roles.map((r) => ({ role: r.role, branchId: r.branchId ?? null })) }),
    setUserRoles: (_: unknown, a: { userId: string; roles: RoleAssignment[] }, ctx: Ctx) =>
      ctx.services.auth.setUserRoles(authorize(ctx, "user:update"), a.userId, a.roles.map((r) => ({ role: r.role, branchId: r.branchId ?? null }))),
    disableUser: (_: unknown, a: { userId: string }, ctx: Ctx) => ctx.services.auth.setUserStatus(authorize(ctx, "user:disable"), a.userId, "disabled"),
    enableUser: (_: unknown, a: { userId: string }, ctx: Ctx) => ctx.services.auth.setUserStatus(authorize(ctx, "user:disable"), a.userId, "active"),
    setUserPassword: async (_: unknown, a: { userId: string; newPassword: string }, ctx: Ctx) => {
      await ctx.services.auth.setUserPassword(authorize(ctx, "user:update"), a.userId, a.newPassword);
      return true;
    },
    upsertRole: (_: unknown, { input }: { input: { key: string; name: string; permissions: string[] } }, ctx: Ctx) =>
      ctx.services.auth.upsertRole(authorize(ctx, "role:manage"), input),
  },
});
