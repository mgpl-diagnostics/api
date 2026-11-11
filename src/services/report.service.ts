import { computeCalculated, flagResult, formatRange, getTestByCode, isNarrative, type Sex as CatalogSex } from "@mgpl-diagnostics/catalog-kit";
import { ConflictError, saveResults, transitionReport, ValidationError, type Booking, type Id, type Report, type Repositories, type ResultValue, type Sex } from "@mgpl-diagnostics/db-kit";
import type { Actor } from "../graphql/context";
import { mustOwn } from "./util";

const catalogSex = (s: Sex): CatalogSex | undefined => (s === "male" || s === "female" ? s : undefined);

/** Age in years today, from the date of birth or the age recorded at registration. */
function patientAge(p: { dob?: Date | string | null; ageYears?: number | null } | null | undefined): number | undefined {
  if (!p) return undefined;
  if (p.dob) {
    const dob = new Date(p.dob);
    if (!Number.isNaN(dob.getTime())) return (Date.now() - dob.getTime()) / (365.2425 * 24 * 3600 * 1000);
  }
  return p.ageYears ?? undefined;
}

/**
 * Fills unit, range and flag from catalog-kit when the report's test is in the catalog and the
 * result does not carry them. Values sent explicitly are kept (the pathologist has the last word).
 * Calculated parameters that were not entered (indirect bilirubin, globulin, A/G ratio, eGFR…) are
 * computed from the entered values with catalog-kit's formulas and appended, in catalog order.
 */
export function withCatalogDefaults(testCode: string, results: ResultValue[], sex: Sex, ageYears?: number | null): ResultValue[] {
  const test = getTestByCode(testCode);
  if (!test) return results;
  const byName = new Map(test.parameters.filter((p) => p.name).map((p) => [p.name!.trim().toLowerCase(), p]));
  const entered = new Map(results.map((r) => [r.parameter.trim().toLowerCase(), r.value] as const));
  const values: Record<string, string> = {};
  for (const p of test.parameters) if (p.name && entered.has(p.name.trim().toLowerCase())) values[p.name] = entered.get(p.name.trim().toLowerCase())!;
  const computed = computeCalculated(test, values, { sex: catalogSex(sex), ageYears: ageYears ?? undefined });
  const extra: ResultValue[] = test.parameters
    .filter((p) => p.name && p.name in computed && !entered.has(p.name.trim().toLowerCase()))
    .map((p) => ({ parameter: p.name!, value: String(computed[p.name!]) }));
  // narrative blocks (interpretation, clinical significance…) print from the catalog, never as results
  const narrative = new Set(test.parameters.filter(isNarrative).map((p) => p.name!.trim().toLowerCase()));
  return [...results, ...extra].filter((r) => !narrative.has(r.parameter.trim().toLowerCase())).map((r) => {
    const p = byName.get(r.parameter.trim().toLowerCase());
    if (!p) return r;
    const out: ResultValue = { ...r };
    if (out.unit == null && p.unit) out.unit = p.unit;
    if (out.range == null) {
      const range = formatRange(p, catalogSex(sex));
      if (range) out.range = range;
    }
    const n = Number(r.value);
    if (out.flag == null && p.type === "numeric" && r.value.trim() !== "" && Number.isFinite(n)) out.flag = flagResult(p, n, catalogSex(sex));
    return out;
  });
}

/** Results entry and the report workflow: draft → entered → verified → released (→ amended → verified). */
export class ReportService {
  constructor(private readonly repos: Repositories) {}

  async get(actor: Actor, id: Id) {
    return mustOwn(await this.repos.reports.get(id), actor.orgId, "Report", id);
  }

  ofBooking(bookingId: Id) {
    return this.repos.reports.find({ bookingId });
  }

  async create(actor: Actor, booking: Booking, testCode: string, testName?: string | null) {
    const t = booking.tests.find((x) => x.testCode === testCode);
    if (!t) throw new ValidationError(`Test ${testCode} is not in booking ${booking.bookingNo}`);
    const existing = await this.repos.reports.findOne({ bookingId: booking.id, testCode });
    if (existing) throw new ConflictError(`Booking ${booking.bookingNo} already has a ${testCode} report`);
    const r = await this.repos.reports.create({
      orgId: booking.orgId, branchId: booking.branchId, bookingId: booking.id, patientId: booking.patientId,
      testCode, testName: testName ?? t.name, results: [], status: "draft", version: 1,
    } as never);
    await this.repos.audit.log({ orgId: actor.orgId, branchId: booking.branchId, userId: actor.userId, action: "report.create", entity: "report", entityId: r.id });
    return r as Report;
  }

  async saveResults(actor: Actor, report: Report, results: ResultValue[]) {
    const imported = await this.repos.reportProvenance.findOne({ reportId: report.id } as never);
    if (imported) {
      // results from a partner PDF: keep the partner's units and ranges (no catalog defaults), and audit the edit
      // against what was imported (ReportProvenance.importedResults keeps the original)
      const out = await saveResults(this.repos, report.id, results, actor.userId);
      await this.repos.audit.log({
        orgId: actor.orgId, branchId: report.branchId, userId: actor.userId, action: "report.edit_imported", entity: "report", entityId: report.id,
        data: { externalReportId: imported.externalReportId, changed: results.filter((r) => !imported.importedResults.some((x) => x.parameter === r.parameter && x.value === r.value)).map((r) => r.parameter) },
      });
      return out;
    }
    const patient = await this.repos.patients.get(report.patientId);
    return saveResults(this.repos, report.id, withCatalogDefaults(report.testCode, results, patient?.sex ?? "other", patientAge(patient)), actor.userId);
  }

  verify(actor: Actor, report: Report) {
    return transitionReport(this.repos, report.id, "verified", actor.userId);
  }

  /** Releasing the last report of a booking completes the booking. */
  async release(actor: Actor, report: Report) {
    const out = await transitionReport(this.repos, report.id, "released", actor.userId);
    const all = await this.repos.reports.find({ bookingId: report.bookingId });
    if (all.every((x) => x.status === "released")) await this.repos.bookings.update(report.bookingId, { status: "completed" });
    return out;
  }

  amend(actor: Actor, report: Report) {
    return transitionReport(this.repos, report.id, "amended", actor.userId);
  }
}
