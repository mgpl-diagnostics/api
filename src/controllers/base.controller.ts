import type { RequestContext } from "../graphql/context";
import { Day, DateTime, JSONScalar } from "../graphql/scalars";
import { VERSION } from "../version";

export const baseController = {
  DateTime,
  Day,
  JSON: JSONScalar,
  Query: {
    health: async (_: unknown, __: unknown, ctx: RequestContext) => {
      let database = "ok";
      try {
        await ctx.repos.orgs.count();
      } catch {
        database = "unreachable";
      }
      return { ok: database === "ok", service: "@mgpl-diagnostics/api", version: VERSION, database, time: new Date() };
    },
  },
  Mutation: {
    ping: () => "pong",
  },
};
