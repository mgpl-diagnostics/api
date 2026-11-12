import * as catalog from "@mgpl-diagnostics/catalog-kit";
import type { LabTest, Parameter } from "@mgpl-diagnostics/catalog-kit";

/** catalog-kit: the lab's tests, parameters, ranges, sample types and prices. Pure data, no tenant. */
export class CatalogService {
  search(query: string, opts: { limit: number; department?: string | null; sampleType?: string | null; fuzzy?: boolean | null }) {
    return catalog.search(query, { limit: opts.limit, department: opts.department ?? undefined, sampleType: opts.sampleType ?? undefined, fuzzy: opts.fuzzy ?? undefined });
  }

  /** By MGPL id ("MGPLT0001"), old numeric id ("10409") or code (case-insensitive). */
  test(key: { id?: string | number | null; code?: string | null }): LabTest | null {
    if (key.id != null && key.id !== "") {
      const id = String(key.id).trim();
      return (/^\d{1,9}$/.test(id) ? catalog.getTest(Number(id)) : catalog.getTest(id)) ?? null;
    }
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

  isPackage(t: LabTest): boolean {
    return catalog.isPackage(t);
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
