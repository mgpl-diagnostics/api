import type { AuditEntry, Organization } from "@mgpl-diagnostics/db-kit";
import type { RequestContext as Ctx } from "../graphql/context";
import { withErrorCodes } from "../graphql/errors";
import { actorOf, authorize, cap } from "../graphql/guards";
import type { BranchInput, OrganizationPatch } from "../services/organization.service";

export const organizationController = withErrorCodes({
  Query: {
    organization: (_: unknown, __: unknown, ctx: Ctx) => ctx.services.organization.organization(actorOf(ctx)),
    branches: (_: unknown, __: unknown, ctx: Ctx) => ctx.services.organization.branches(actorOf(ctx)),
    branch: async (_: unknown, a: { id: string }, ctx: Ctx) => {
      const b = await ctx.loaders.branch.load(a.id);
      return b && b.orgId === actorOf(ctx).orgId ? b : null;
    },
    auditLog: (_: unknown, a: { entity?: string | null; entityId?: string | null; limit?: number; offset?: number }, ctx: Ctx) =>
      ctx.services.organization.audit(authorize(ctx, "audit:read"), { entity: a.entity, entityId: a.entityId, limit: cap(a.limit, 50), offset: a.offset ?? 0 }),
  },
  Organization: {
    branches: (o: Organization, _: unknown, ctx: Ctx) => ctx.services.organization.branches({ orgId: o.id, userId: ctx.viewer!.userId }),
  },
  AuditEntry: {
    user: (e: AuditEntry, _: unknown, ctx: Ctx) => ctx.loaders.user.load(e.userId).then((u) => (u ? (({ passwordHash: _p, ...rest }) => rest)(u) : null)),
  },
  Mutation: {
    updateOrganization: (_: unknown, { input }: { input: OrganizationPatch }, ctx: Ctx) => ctx.services.organization.updateOrganization(authorize(ctx, "org:update"), input),
    createBranch: (_: unknown, { input }: { input: BranchInput }, ctx: Ctx) => ctx.services.organization.createBranch(authorize(ctx, "branch:create"), input),
    updateBranch: (_: unknown, a: { id: string; input: Partial<BranchInput> }, ctx: Ctx) => ctx.services.organization.updateBranch(authorize(ctx, "branch:update", a.id), a.id, a.input),
  },
});
