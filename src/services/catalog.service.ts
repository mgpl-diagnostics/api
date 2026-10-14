import * as catalog from "@mgpl-diagnostics/catalog-kit";
import type { LabTest, Parameter } from "@mgpl-diagnostics/catalog-kit";

/** catalog-kit: the lab's tests, parameters, ranges, sample types and prices. Pure data, no tenant. */
export class CatalogService {
  search(query: string, opts: { limit: number; department?: string | null; sampleType?: string | null; fuzzy?: boolean | null }) {
    return catalog.search(query, { limit: opts.limit, department: opts.department ?? undefined, sampleType: opts.sampleType ?? undefined, fuzzy: opts.fuzzy ?? undefined });
  }

  /** By numeric id or by code (case-insensitive). */
  test(key: { id?: number | null; code?: string | null }): LabTest | null {
    if (key.id != null) return catalog.getTest(key.id) ?? null;
    if (key.code) return catalog.getTestByCode(key.code) ?? null;
    return null;
  }

  tests(q: { department?: string | null; sampleType?: string | null; limit: number; offset: number }): LabTest[] {
    let list: readonly LabTest[] = catalog.TESTS;
    if (q.department) list = catalog.testsByDepartment(q.department);
    if (q.sampleType) list = list.filter((t) => t.sampleType === q.sampleType || t.secondarySampleTypes?.includes(q.sampleType!));
    return list.slice(q.offset, q.offset + q.limit);
  }

  count(): number {
    return catalog.TESTS.length;
  }

  departments(): readonly string[] {
    return catalog.DEPARTMENTS;
  }

  sampleTypes(): readonly string[] {
    return catalog.SAMPLE_TYPES;
  }

  isProfile(t: LabTest): boolean {
    return catalog.isProfile(t);
  }

  formatRange(p: Parameter, sex?: catalog.Sex | null): string {
    return catalog.formatRange(p, sex ?? undefined);
  }

  /** "L", "H" or "" for a numeric result against the parameter's range. */
  flag(p: Parameter, value: number, sex?: catalog.Sex | null): string {
    return catalog.flagResult(p, value, sex ?? undefined);
  }

  /** Price quote for test ids or codes: total in rupees, the tests found and the keys not found. */
  quote(items: (string | number)[]) {
    return catalog.totalPrice(items);
  }
}
