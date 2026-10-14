import type { Id } from "@mgpl-diagnostics/db-kit";
import type { Actor, RequestContext } from "./context";
import { forbidden, unauthenticated } from "./errors";

/** The signed-in user as an Actor; UNAUTHENTICATED otherwise. */
export function actorOf(ctx: RequestContext): Actor {
  if (!ctx.viewer) throw unauthenticated();
  return { userId: ctx.viewer.userId, orgId: ctx.viewer.orgId };
}

/** FORBIDDEN unless the viewer has `permission` in `branchId` (anywhere, when omitted). */
export function authorize(ctx: RequestContext, permission: string, branchId?: Id | null): Actor {
  const actor = actorOf(ctx);
  if (!ctx.can(permission, branchId)) throw forbidden(permission);
  return actor;
}

/** True when the viewer may see a nested field (no error: the field resolves to empty). */
export const canSee = (ctx: RequestContext, permission: string, branchId?: Id | null) => !!ctx.viewer && ctx.can(permission, branchId);

/** The branch filter for a list: the requested branch (checked) or every branch the viewer may read. */
export function branchScope(ctx: RequestContext, permission: string, branchId?: Id | null): "all" | Id[] {
  if (branchId) {
    authorize(ctx, permission, branchId);
    return [branchId];
  }
  actorOf(ctx);
  const allowed = ctx.branchesFor(permission);
  if (allowed !== "all" && !allowed.length) throw forbidden(permission);
  return allowed;
}

/** List limits are capped at 200. */
export const cap = (n: number | null | undefined, d: number) => Math.min(Math.max(1, n ?? d), 200);
