import type { Interval, LabTest, Parameter } from "@mgpl-diagnostics/catalog-kit";
import type { RequestContext as Ctx } from "../graphql/context";
import { withErrorCodes } from "../graphql/errors";
import { cap } from "../graphql/guards";

const bound = (b: Interval["low"]) => (b == null ? null : String(b));

/** catalog-kit. Public: the same tests and prices are on the website. */
export const catalogController = withErrorCodes({
  Query: {
    catalogSearch: (_: unknown, a: { query: string; limit?: number; department?: string | null; sampleType?: string | null; fuzzy?: boolean | null }, ctx: Ctx) =>
      ctx.services.catalog.search(a.query, { limit: cap(a.limit, 20), department: a.department, sampleType: a.sampleType, fuzzy: a.fuzzy }),
    catalogTest: (_: unknown, a: { id?: number | null; code?: string | null }, ctx: Ctx) => ctx.services.catalog.test(a),
    catalogTests: (_: unknown, a: { department?: string | null; sampleType?: string | null; limit?: number; offset?: number }, ctx: Ctx) =>
      ctx.services.catalog.tests({ department: a.department, sampleType: a.sampleType, limit: cap(a.limit, 50), offset: a.offset ?? 0 }),
    catalogDepartments: (_: unknown, __: unknown, ctx: Ctx) => ctx.services.catalog.departments(),
    catalogSampleTypes: (_: unknown, __: unknown, ctx: Ctx) => ctx.services.catalog.sampleTypes(),
    priceQuote: (_: unknown, a: { tests: string[] }, ctx: Ctx) => {
      const q = ctx.services.catalog.quote(a.tests.slice(0, 200).map((t) => (/^\d+$/.test(t) ? Number(t) : t)));
      return { total: q.total, totalPaise: q.total * 100, tests: q.tests, unknown: q.unknown.map(String) };
    },
  },
  CatalogTest: {
    pricePaise: (t: LabTest) => (t.mrp == null ? null : t.mrp * 100),
    isProfile: (t: LabTest, _: unknown, ctx: Ctx) => ctx.services.catalog.isProfile(t),
  },
  CatalogParameter: {
    male: (p: Parameter) => (p.male ? { low: bound(p.male.low), high: bound(p.male.high) } : null),
    female: (p: Parameter) => (p.female ? { low: bound(p.female.low), high: bound(p.female.high) } : null),
    range: (p: Parameter, a: { sex?: "male" | "female" | "other" | null }, ctx: Ctx) => ctx.services.catalog.formatRange(p, a.sex === "other" ? null : a.sex),
  },
});
