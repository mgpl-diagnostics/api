import type { RequestContext as Ctx } from "../graphql/context";
import { withErrorCodes } from "../graphql/errors";
import { authorize } from "../graphql/guards";

export const systemController = withErrorCodes({
  Query: {
    systemUpdates: (_: unknown, a: { dashboardVersion?: string | null; refresh?: boolean | null }, ctx: Ctx) => {
      authorize(ctx, "settings:manage");
      return ctx.services.system.updates({ dashboardVersion: a.dashboardVersion?.slice(0, 40), refresh: a.refresh });
    },
  },
});
