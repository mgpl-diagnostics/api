import type { RoleAssignment, User } from "@mgpl-diagnostics/db-kit";
import type { RequestContext as Ctx } from "../graphql/context";
import { unauthenticated, withErrorCodes } from "../graphql/errors";
import { actorOf, authorize } from "../graphql/guards";

/** auth-kit: sign-in, sessions, passwords; users and roles. */
export const authController = withErrorCodes({
  Query: {
    viewer: (_: unknown, __: unknown, ctx: Ctx) => (ctx.viewer ? {} : null),
    mySessions: async (_: unknown, __: unknown, ctx: Ctx) => {
      const sessions = await ctx.services.auth.sessions(actorOf(ctx));
      return sessions.map((s) => ({ ...s, current: s.id === ctx.viewer!.sessionId, createdAt: new Date(s.createdAt), lastSeenAt: new Date(s.lastSeenAt), expiresAt: new Date(s.expiresAt) }));
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
    login: (_: unknown, { input }: { input: { email: string; password: string; orgCode?: string | null } }, ctx: Ctx) =>
      ctx.services.auth.login({ ...input, ip: ctx.ip, userAgent: ctx.userAgent }),
    logout: async (_: unknown, __: unknown, ctx: Ctx) => {
      if (!ctx.token) throw unauthenticated();
      await ctx.services.auth.logout(ctx.token);
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
