import { createHash, randomUUID } from "node:crypto";
import { getTestByCode, search as catalogSearch } from "@mgpl-diagnostics/catalog-kit";
import {
  ConflictError, NotFoundError, saveResults, ValidationError,
  type Booking, type ExternalLabId, type ExternalReport, type ExternalSignatory, type ExternalSignatoryRole, type Id, type Patient,
  type Report, type ReportProvenance, type Repositories, type ResultValue,
} from "@mgpl-diagnostics/db-kit";
import {
  extractReport, labelFor, toPng, UnsupportedReportError,
  type ExtractedReport, type KnownSignature, type TestSection,
} from "@mgpl-diagnostics/report-reader";
import type { ReportTestProvenance } from "@mgpl-diagnostics/report-kit";
import type { Actor } from "../graphql/context";
import { UNSUPPORTED_PREFIX } from "../jobs/processors";
import { JobFailure, type ImportJob, type JobQueue } from "../jobs/types";
import { mustOwn } from "./util";

/** The PDF is larger than IMPORT_MAX_BYTES (FILE_TOO_LARGE). */
export class FileTooLargeError extends Error {
  constructor(readonly bytes: number, readonly maxBytes: number) {
    super(`The file is ${(bytes / 1048576).toFixed(1)} MB; the limit is ${(maxBytes / 1048576).toFixed(0)} MB`);
    this.name = "FileTooLargeError";
  }
}

/** The external report was already applied to our reports (REPORT_ALREADY_APPLIED). */
export class ReportAlreadyAppliedError extends ConflictError {
  constructor() {
    super("This partner report was already applied");
    this.name = "ReportAlreadyAppliedError";
  }
}

/** The booking's patient does not match the partner report's, and staff have not confirmed it (BOOKING_PATIENT_MISMATCH). */
export class BookingPatientMismatchError extends ConflictError {
  constructor(readonly mismatches: string[]) {
    super(`The booking's patient does not match the partner report (${mismatches.join("; ")}). Check, then apply with confirmPatientMismatch: true`);
    this.name = "BookingPatientMismatchError";
  }
}

export { UnsupportedReportError };

export interface ImportInput {
  pdf: Uint8Array;
  fileName?: string | null;
  branchId: Id;
  bookingId?: Id | null;
}

export interface TestMapping {
  testIndex: number;
  testCode: string;
  include?: boolean | null;
}

export interface SignatoryInput {
  sha: string;
  lab: ExternalLabId;
  name: string;
  qualification?: string | null;
  registration?: string | null;
  title?: string | null;
  role?: string | null;
}

export interface ImportLimits {
  maxBytes: number;
  inlineMaxBytes: number;
  waitMs: number;
}

const ROLES: ExternalSignatoryRole[] = ["pathologist", "biochemist", "microbiologist", "consultant", "manager", "unknown"];
const TITLES = /^(mr|mrs|ms|miss|master|mstr|baby|bby|b\/o|dr|smt|shri|sri|kumari|ku|kum|md|mx)\.?\s+/i;
const MATCH_PREFIX = "Booking check: ";

/** Name for comparison: lower case, no titles, letters and spaces only. */
export function normName(name: string | null | undefined): string {
  let n = (name ?? "").toLowerCase().replace(/[^a-z\s/]/g, " ").replace(/\s+/g, " ").trim();
  while (TITLES.test(n)) n = n.replace(TITLES, "").trim();
  return n.replace(/\//g, " ").replace(/\s+/g, " ").trim();
}

function ageYears(p: Patient, at: Date): number | null {
  if (p.ageYears != null) return p.ageYears;
  if (!p.dob) return null;
  const dob = new Date(p.dob);
  let y = at.getUTCFullYear() - dob.getUTCFullYear();
  if (at.getUTCMonth() < dob.getUTCMonth() || (at.getUTCMonth() === dob.getUTCMonth() && at.getUTCDate() < dob.getUTCDate())) y--;
  return y;
}

/**
 * Differences between our booking's patient and the partner report's: name (case-insensitive, without
 * titles), sex, age within ±1 year. Each is a warning that staff must confirm before applying.
 */
export function patientMismatches(report: ExtractedReport, patient: Patient, at = new Date()): string[] {
  const out: string[] = [];
  const theirs = normName(report.patient.name);
  const ours = normName(patient.name);
  if (theirs && ours && theirs !== ours) out.push(`patient name "${report.patient.name}" differs from the booking's "${patient.name}"`);
  if (!theirs) out.push("the partner report prints no patient name");
  if (report.patient.sex && patient.sex !== "other" && report.patient.sex !== patient.sex) out.push(`sex ${report.patient.sex} differs from the booking's ${patient.sex}`);
  const ourAge = ageYears(patient, at);
  if (report.patient.ageYears != null && ourAge != null && Math.abs(report.patient.ageYears - ourAge) > 1) out.push(`age ${report.patient.ageYears} differs from the booking's ${ourAge}`);
  return out;
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/** Our catalog parameter name for a partner parameter, within the chosen test; the partner's own name when none matches. */
export function mapParameter(testCode: string, name: string): string {
  const test = getTestByCode(testCode);
  if (!test) return name;
  const want = norm(name);
  const named = test.parameters.filter((p): p is typeof p & { name: string } => !!p.name);
  const exact = named.find((p) => norm(p.name) === want);
  if (exact) return exact.name;
  // "Haemoglobin (HB)" ~ "Hemoglobin": compare without bracketed abbreviations and common spelling variants
  const loose = (s: string) => norm(s.replace(/\([^)]*\)/g, "")).replace(/ae/g, "e").replace(/oe/g, "e").replace(/\s+/g, "");
  const l = loose(name);
  const hit = named.find((p) => loose(p.name) === l);
  return hit ? hit.name : name;
}

/**
 * The catalog test suggested for a partner test, for staff to confirm. With the booking's test codes, the
 * best search hit among them ("LIVER FUNCTION TEST" → the booking's LFT); otherwise the top hit.
 */
export function suggestTestCode(name: string, bookingCodes?: readonly string[]): string | null {
  if (bookingCodes?.length) {
    const hit = catalogSearch(name, { limit: 10 }).find((h) => h.test.code && bookingCodes.includes(h.test.code));
    if (hit) return hit.test.code!;
  }
  return catalogSearch(name, { limit: 1 })[0]?.test.code ?? null;
}

/** A booking that may be the one a partner report belongs to, with why. */
export interface BookingCandidate {
  booking: Booking;
  /** 0 to 100 */
  score: number;
  reasons: string[];
  patientMismatches: string[];
  /** For each partner test (by index), the booking's test it maps to, if any. */
  mappings: { testIndex: number; testCode: string | null }[];
  /** Name, sex and age agree and at least one test maps: safe to suggest first. */
  strong: boolean;
}

/** How alike two names are, without titles: 50 same, 35 one contains the other's words, 15 same first name, else 0. */
export function nameScore(a: string | null | undefined, b: string | null | undefined): number {
  const x = normName(a), y = normName(b);
  if (!x || !y) return 0;
  if (x === y) return 50;
  const xs = x.split(" "), ys = y.split(" ");
  const within = (p: string[], q: string[]) => p.length > 1 && p.every((w) => q.includes(w));
  if (within(xs, ys) || within(ys, xs)) return 35;
  if (xs[0] === ys[0] && xs[0]!.length > 2) return 15;
  return 0;
}

/**
 * Scores one booking against a partner report: name, sex, age (±1), the partner tests that map to the
 * booked tests, and how recent the booking is. Pure, so it is tested without a database.
 */
export function scoreCandidate(report: ExtractedReport, booking: Booking, patient: Patient, at = new Date()): BookingCandidate {
  const reasons: string[] = [];
  let score = 0;
  const ns = nameScore(report.patient.name, patient.name);
  score += ns;
  if (ns === 50) reasons.push("same name");
  else if (ns === 35) reasons.push("name matches in part");
  else if (ns === 15) reasons.push("same first name");
  let agree = ns >= 35;
  if (report.patient.sex && patient.sex !== "other") {
    if (report.patient.sex === patient.sex) (score += 10), reasons.push("same sex");
    else (score -= 30), (agree = false);
  }
  const ours = ageYears(patient, at);
  if (report.patient.ageYears != null && ours != null) {
    if (Math.abs(report.patient.ageYears - ours) <= 1) (score += 10), reasons.push(`age ${ours}`);
    else (score -= 20), (agree = false);
  }
  const codes = booking.tests.map((t) => t.testCode);
  const mappings = report.tests.map((t, testIndex) => {
    const c = suggestTestCode(t.name, codes);
    return { testIndex, testCode: c && codes.includes(c) ? c : null };
  });
  const mapped = [...new Set(mappings.map((m) => m.testCode).filter((c): c is string => !!c))];
  if (mapped.length) {
    score += Math.min(30, 15 * mapped.length);
    reasons.push(`booked ${mapped.join(", ")}`);
  } else score -= 10;
  const days = (at.getTime() - new Date(booking.createdAt).getTime()) / 86_400_000;
  if (days <= 7) (score += 10), reasons.push(days < 1 ? "booked today" : `booked ${Math.round(days)} day${Math.round(days) === 1 ? "" : "s"} ago`);
  else if (days <= 30) score += 5;
  if (booking.status === "completed") score -= 15;
  return {
    booking, score: Math.max(0, Math.min(100, score)), reasons, mappings,
    patientMismatches: patientMismatches(report, patient, at),
    strong: agree && mapped.length > 0,
  };
}

/** Bookings an import can be tied to: open ones (not cancelled), newest first. */
const OPEN = new Set(["booked", "sample_collected", "in_process", "completed"]);

const sha256 = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

/** db-kit registry rows → report-reader's KnownSignature (data, never source code). */
export const knownSignatures = (rows: ExternalSignatory[]): KnownSignature[] =>
  rows.map((r) => ({
    name: r.name, sha: r.sha, dhash: r.dhash, lab: r.lab,
    ...(r.qualification ? { qualification: r.qualification } : {}),
    ...(r.registration ? { registration: r.registration } : {}),
    ...(r.title ? { title: r.title } : {}),
    ...(r.role && r.role !== "unknown" ? { role: r.role } : {}),
  }));

/** The printed provenance (report-kit) for one of our reports imported from a partner PDF. */
/** "Clinova Pathlabs, Central Lab, City" printed after "Performed at Clinova Pathlabs": drop the repeated name. */
export function placeOf(performedBy: string, performedAt?: string | null): string | null {
  const at = performedAt?.trim();
  if (!at) return null;
  const rest = at.toLowerCase().startsWith(performedBy.toLowerCase()) ? at.slice(performedBy.length).replace(/^[\s,;:-]+/, "") : at;
  return rest || null;
}

export function printedProvenance(p: ReportProvenance): Omit<ReportTestProvenance, "reportedBy"> & { performedBy: string } {
  return {
    performedBy: p.performedBy,
    ...(placeOf(p.performedBy, p.performedAt) ? { performedAt: placeOf(p.performedBy, p.performedAt)! } : {}),
    ...(p.accreditation ? { accreditationText: `NABL accredited laboratory${p.accreditation.certificate ? ` (Certificate No. ${p.accreditation.certificate})` : ""}` } : {}),
    sourceId: p.sourceSha256,
  };
}

/**
 * Partner-lab report imports (report-reader): upload → extract → store; match to a booking; apply to our
 * reports with provenance; the partner signature registry. Results enter the normal flow (saveResults →
 * verifyReport); an import never verifies or releases anything. The PDF, the extracted JSON and the
 * signature images are patient / personal data: they are stored per organisation and never logged.
 */
export class ImportService {
  constructor(
    private readonly repos: Repositories,
    private readonly queue: () => JobQueue,
    private readonly limits: ImportLimits,
  ) {}

  async get(actor: Actor, id: Id): Promise<ExternalReport> {
    return mustOwn(await this.repos.externalReports.get(id), actor.orgId, "External report", id);
  }

  /** The existing import of this exact PDF in the organisation, if any (checked before the caller authorizes the branch). */
  async existing(actor: Actor, pdf: Uint8Array): Promise<ExternalReport | null> {
    return this.repos.externalReports.findOne({ orgId: actor.orgId, sourceSha256: sha256(pdf) } as never);
  }

  assertSize(bytes: number) {
    if (bytes > this.limits.maxBytes) throw new FileTooLargeError(bytes, this.limits.maxBytes);
    if (bytes < 5) throw new ValidationError("The file is empty");
  }

  /**
   * Stores the PDF and extracts it: in this request up to IMPORT_INLINE_MAX_BYTES, otherwise in the worker
   * (the job carries the stored file's id, never the file). The same PDF uploaded again returns its row.
   */
  async import(actor: Actor, input: ImportInput): Promise<ExternalReport> {
    this.assertSize(input.pdf.byteLength);
    const sourceSha256 = sha256(input.pdf);
    const before = await this.repos.externalReports.findOne({ orgId: actor.orgId, sourceSha256 } as never);
    if (before) return before;
    if (input.bookingId) {
      const b = mustOwn(await this.repos.bookings.get(input.bookingId), actor.orgId, "Booking", input.bookingId);
      if (b.branchId !== input.branchId) throw new ValidationError("The booking belongs to another branch");
    }

    const fileId = randomUUID();
    try {
      await this.repos.externalReportFiles.create({ id: fileId, orgId: actor.orgId, sourceSha256, byteLength: input.pdf.byteLength, pdf: input.pdf });
    } catch (e) {
      // the same PDF being imported right now by someone else
      const row = await this.repos.externalReports.findOne({ orgId: actor.orgId, sourceSha256 } as never);
      if (row) return row;
      if (await this.repos.externalReportFiles.findOne({ orgId: actor.orgId, sourceSha256 } as never)) throw new ConflictError("This PDF is being imported; try again in a moment");
      throw e;
    }

    const job: ImportJob = { kind: "extract", actor, fileId, branchId: input.branchId, bookingId: input.bookingId ?? null, fileName: input.fileName ?? null };
    if (input.pdf.byteLength <= this.limits.inlineMaxBytes || this.queue().mode === "inline") return this.extractStored(actor, job);
    try {
      const { externalReportId } = await this.queue().importReport(job, this.limits.waitMs);
      return this.get(actor, externalReportId);
    } catch (e) {
      if (e instanceof JobFailure && e.message.startsWith(UNSUPPORTED_PREFIX)) throw new UnsupportedReportError(e.message.slice(UNSUPPORTED_PREFIX.length));
      if (e instanceof JobFailure) throw new ConflictError(e.message);
      throw e;
    }
  }

  /** Extracts a stored PDF and creates its external report (inline, or in the worker). An unsupported PDF is not kept. */
  async extractStored(actor: Actor, job: Omit<ImportJob, "kind" | "actor">): Promise<ExternalReport> {
    const file = mustOwn(await this.repos.externalReportFiles.get(job.fileId), actor.orgId, "File", job.fileId);
    const done = await this.repos.externalReports.get(file.id);
    if (done) return done; // a retried job
    let extracted: Awaited<ReturnType<typeof extractReport>>;
    try {
      extracted = await extractReport(new Uint8Array(file.pdf), { file: job.fileName ?? undefined, signatures: knownSignatures(await this.repos.externalSignatories.listForOrg(actor.orgId)) });
    } catch (e) {
      await this.repos.externalReportFiles.delete(file.id);
      if (e instanceof UnsupportedReportError) throw e;
      // a PDF the reader cannot open at all is unsupported too (never echo its contents)
      throw new UnsupportedReportError("The PDF could not be read as a partner-lab report");
    }
    const { report, images } = extracted;
    const booking = job.bookingId ? await this.repos.bookings.get(job.bookingId) : null;
    const matchWarnings = booking ? await this.bookingWarnings(report, booking) : [];
    const now = new Date();
    const row = await this.repos.transaction(async (tx) => {
      const row = await tx.externalReports.create({
        id: file.id, orgId: actor.orgId, branchId: job.branchId, bookingId: booking?.id ?? null,
        lab: report.source.lab, labName: report.source.labName, processedAt: report.source.processedAt ?? null,
        sourceSha256: report.source.sha256, fileName: job.fileName ?? null, byteLength: file.byteLength,
        extracted: report as unknown as Record<string, unknown>, status: booking ? "matched" : "extracted",
        warnings: [...report.warnings, ...matchWarnings], uploadedBy: actor.userId, uploadedAt: now,
      });
      for (const s of report.signatories) {
        const img = images.get(s.id);
        if (!img || !s.signature.sha) continue;
        await tx.externalSignatures.create({
          orgId: actor.orgId, externalReportId: row.id, sourceSha256: report.source.sha256,
          sha: s.signature.sha, dhash: s.signature.dhash, width: img.width, height: img.height, png: toPng(img),
        });
      }
      await tx.audit.log({ orgId: actor.orgId, branchId: job.branchId, userId: actor.userId, action: "external_report.import", entity: "external_report", entityId: row.id, data: { lab: row.lab, tests: report.tests.length } });
      return row;
    });
    if (booking) return row;
    // no booking given: tie it to the one booking it clearly belongs to, if there is exactly one
    const found = await this.autoMatchFor(actor, row);
    return found ? this.match(actor, row, found, true) : row;
  }

  /**
   * Bookings this partner report may belong to, best first: patients found by the printed name (whole,
   * then each word of 3+ letters), their recent bookings in `scope`, scored by name, sex, age and the
   * booked tests (scoreCandidate). Candidates with nothing in common are left out.
   */
  async candidates(actor: Actor, ext: ExternalReport, scope: "all" | Id[], limit = 5): Promise<BookingCandidate[]> {
    const report = ext.extracted as unknown as ExtractedReport;
    const name = normName(report.patient.name);
    if (!name) return [];
    const patients = new Map<Id, Patient>();
    for (const q of [name, ...name.split(" ").filter((w) => w.length >= 3)]) {
      for (const p of await this.repos.patients.search(actor.orgId, q, 20)) if (p.orgId === actor.orgId) patients.set(p.id, p);
      if (patients.size >= 40) break;
    }
    const since = Date.now() - 90 * 86_400_000;
    const out: BookingCandidate[] = [];
    for (const p of patients.values()) {
      if (!nameScore(report.patient.name, p.name)) continue;
      const bookings = await this.repos.bookings.find({ orgId: actor.orgId, patientId: p.id } as never, { sort: { field: "createdAt", dir: "desc" }, limit: 5 });
      for (const b of bookings) {
        if (!OPEN.has(b.status) || new Date(b.createdAt).getTime() < since) continue;
        if (scope !== "all" && !scope.includes(b.branchId)) continue;
        const c = scoreCandidate(report, b, p);
        if (c.score > 0) out.push(c);
      }
    }
    return out.sort((a, b) => Number(b.strong) - Number(a.strong) || b.score - a.score).slice(0, limit);
  }

  /**
   * The one booking an upload clearly belongs to, or null: a strong candidate in the upload's branch with
   * no other strong candidate within 20 points. Staff still review and apply; matching is reversible.
   */
  async autoMatchFor(actor: Actor, ext: ExternalReport): Promise<Booking | null> {
    const [top, next] = await this.candidates(actor, ext, [ext.branchId], 2);
    if (!top?.strong) return null;
    if (next?.strong && next.score > top.score - 20) return null;
    return top.booking;
  }

  private async bookingWarnings(report: ExtractedReport, booking: Booking): Promise<string[]> {
    const patient = await this.repos.patients.get(booking.patientId);
    return patient ? patientMismatches(report, patient).map((m) => MATCH_PREFIX + m) : [`${MATCH_PREFIX}the booking's patient was not found`];
  }

  /** Ties an import to a booking (or another booking). Name, sex and age are compared; differences become warnings. */
  async match(actor: Actor, ext: ExternalReport, booking: Booking, auto = false): Promise<ExternalReport> {
    if (ext.status === "applied") throw new ReportAlreadyAppliedError();
    if (ext.status === "rejected") throw new ConflictError("This partner report was rejected");
    const report = ext.extracted as unknown as ExtractedReport;
    const warnings = [...ext.warnings.filter((w) => !w.startsWith(MATCH_PREFIX)), ...(await this.bookingWarnings(report, booking))];
    const out = await this.repos.externalReports.update(ext.id, { bookingId: booking.id, branchId: booking.branchId, status: "matched", warnings });
    await this.repos.audit.log({ orgId: actor.orgId, branchId: booking.branchId, userId: actor.userId, action: auto ? "external_report.auto_match" : "external_report.match", entity: "external_report", entityId: ext.id, data: { bookingId: booking.id } });
    return out!;
  }

  /** Patient differences recorded when the import was matched. */
  mismatches(ext: ExternalReport): string[] {
    return ext.warnings.filter((w) => w.startsWith(MATCH_PREFIX)).map((w) => w.slice(MATCH_PREFIX.length));
  }

  /**
   * Writes the mapped partner tests into our reports (one per test code), as entered results with their
   * provenance. Values, units, ranges and flags are copied as printed: the partner's range applies to the
   * partner's method. Staff verify as usual; nothing is verified or released here.
   */
  async apply(actor: Actor, ext: ExternalReport, booking: Booking, mappings: TestMapping[], confirmPatientMismatch: boolean): Promise<Report[]> {
    if (ext.status === "applied") throw new ReportAlreadyAppliedError();
    if (ext.status === "rejected") throw new ConflictError("This partner report was rejected");
    if (!ext.bookingId || ext.bookingId !== booking.id) throw new ValidationError("Match the partner report to a booking first (matchExternalReport)");
    const mismatches = this.mismatches(ext);
    if (mismatches.length && !confirmPatientMismatch) throw new BookingPatientMismatchError(mismatches);
    const report = ext.extracted as unknown as ExtractedReport;
    const chosen = mappings.filter((m) => m.include !== false);
    if (!chosen.length) throw new ValidationError("Choose at least one test to apply");
    const codes = new Set<string>();
    for (const m of chosen) {
      if (!Number.isInteger(m.testIndex) || !report.tests[m.testIndex]) throw new ValidationError(`No test at index ${m.testIndex}`);
      if (!booking.tests.some((t) => t.testCode === m.testCode)) throw new ValidationError(`Test ${m.testCode} is not in booking ${booking.bookingNo}`);
      if (codes.has(m.testCode)) throw new ValidationError(`Test ${m.testCode} is mapped twice`);
      codes.add(m.testCode);
    }

    return this.repos.transaction(async (tx) => {
      const out: Report[] = [];
      for (const m of chosen) {
        const test = report.tests[m.testIndex]!;
        const results = this.resultsOf(test, m.testCode);
        if (!results.length) throw new ValidationError(`The partner test "${test.name}" has no results to apply`);
        let ours = await tx.reports.findOne({ bookingId: booking.id, testCode: m.testCode } as never);
        if (ours && (!["draft", "entered"].includes(ours.status) || (await tx.reportProvenance.findOne({ reportId: ours.id } as never))))
          throw new ConflictError(`Booking ${booking.bookingNo} already has a ${m.testCode} report (${ours.status})`);
        if (!ours) {
          const bt = booking.tests.find((t) => t.testCode === m.testCode)!;
          ours = await tx.reports.create({
            orgId: booking.orgId, branchId: booking.branchId, bookingId: booking.id, patientId: booking.patientId,
            testCode: m.testCode, testName: bt.name, results: [], status: "draft", version: 1,
          } as never);
          await tx.audit.log({ orgId: actor.orgId, branchId: booking.branchId, userId: actor.userId, action: "report.create", entity: "report", entityId: ours.id, data: { externalReportId: ext.id } });
        }
        const label = labelFor(report, test);
        await tx.reportProvenance.create({
          orgId: actor.orgId, reportId: ours.id, externalReportId: ext.id, sourceSha256: ext.sourceSha256, lab: ext.lab, testIndex: m.testIndex,
          performedBy: label.performedBy, performedAt: label.performedAt ?? null,
          reportedBy: label.reportedBy.map((r) => ({
            signatoryId: r.id, name: r.name,
            ...(r.qualification ? { qualification: r.qualification } : {}),
            ...(r.registration ? { registration: r.registration } : {}),
            ...(r.title ? { title: r.title } : {}),
            role: r.role,
          })),
          accreditation: label.accreditation ?? null,
          sourceTestName: test.name, sourceSampleId: test.sampleId ?? null, sourceReportedAt: test.reported ?? report.dates.reported ?? null,
          importedResults: results, appliedBy: actor.userId,
        });
        // the normal flow: results entered (verification stays with our staff)
        out.push(await saveResults(tx, ours.id, results, actor.userId));
      }
      await tx.externalReports.update(ext.id, { status: "applied", appliedBy: actor.userId, appliedAt: new Date() });
      await tx.audit.log({ orgId: actor.orgId, branchId: booking.branchId, userId: actor.userId, action: "external_report.apply", entity: "external_report", entityId: ext.id, data: { reports: out.map((r) => r.id), confirmedMismatch: mismatches.length > 0 } });
      return out;
    });
  }

  /** A partner test's results as our ResultInput, copied as printed (parameter names mapped to our catalog where they match). */
  resultsOf(test: TestSection, testCode: string): ResultValue[] {
    return test.parameters
      .filter((p) => p.name.trim() && p.value.trim())
      .map((p) => ({
        parameter: mapParameter(testCode, p.name),
        value: p.value,
        ...(p.unit ? { unit: p.unit } : {}),
        ...(p.range ? { range: p.range } : {}),
        flag: p.flag,
      }));
  }

  /** Our reports an import was applied to. */
  async reportsOf(ext: ExternalReport): Promise<Report[]> {
    const rows = await this.repos.reportProvenance.find({ orgId: ext.orgId, externalReportId: ext.id } as never, { limit: 200 });
    return rows.length ? this.repos.reports.getMany(rows.map((r) => r.reportId)) : [];
  }

  async reject(actor: Actor, ext: ExternalReport, reason: string): Promise<ExternalReport> {
    if (ext.status === "applied") throw new ReportAlreadyAppliedError();
    if (!reason.trim()) throw new ValidationError("A reason is required");
    const out = await this.repos.externalReports.update(ext.id, { status: "rejected", rejectedBy: actor.userId, rejectReason: reason.trim() });
    await this.repos.audit.log({ orgId: actor.orgId, branchId: ext.branchId, userId: actor.userId, action: "external_report.reject", entity: "external_report", entityId: ext.id });
    return out!;
  }

  async list(actor: Actor, o: { scope: "all" | Id[]; bookingId?: Id | null; status?: ExternalReport["status"] | null; limit: number; offset: number }) {
    const filter: Record<string, unknown> = { orgId: actor.orgId, ...(o.bookingId ? { bookingId: o.bookingId } : {}), ...(o.status ? { status: o.status } : {}) };
    const sort = { field: "uploadedAt" as const, dir: "desc" as const };
    // one more than asked, to know whether there is a next page
    if (o.scope === "all") return this.repos.externalReports.find(filter as never, { limit: o.limit + 1, offset: o.offset, sort });
    const lists = await Promise.all(o.scope.map((b) => this.repos.externalReports.find({ ...filter, branchId: b } as never, { limit: o.limit + 1 + o.offset, sort })));
    return lists.flat().sort((a, b) => +b.uploadedAt - +a.uploadedAt).slice(o.offset, o.offset + o.limit + 1);
  }

  // ---------------------------------------------------------------- signatures

  /**
   * A signature image, only from the PDF it came from: looked up by (organisation, sourceSha256, sha). The
   * caller passes the sourceSha256 of the results it shows; a stored signature is never picked by sha alone.
   */
  signatureImage(orgId: Id, sourceSha256: string, sha: string) {
    if (!sha) return Promise.resolve(null);
    return this.repos.externalSignatures.findOne({ orgId, sourceSha256, sha } as never);
  }

  signatories(actor: Actor, lab?: ExternalLabId | null) {
    return this.repos.externalSignatories.listForOrg(actor.orgId, lab ?? undefined);
  }

  /**
   * Names a partner signature once (an authorised user, from what the signature shows). Adds the sha and
   * its dhash to the registry entry of that person (the same sha, or the same lab + name + registration),
   * then re-extracts the organisation's unapplied imports that carry it, in the background.
   */
  async nameSignature(actor: Actor, input: SignatoryInput): Promise<ExternalSignatory> {
    const name = input.name.trim();
    if (!name) throw new ValidationError("A name is required");
    if (input.role && !ROLES.includes(input.role as ExternalSignatoryRole)) throw new ValidationError(`role must be one of ${ROLES.join(", ")}`);
    const seen = await this.repos.externalSignatures.findOne({ orgId: actor.orgId, sha: input.sha } as never);
    if (!seen) throw new NotFoundError("Signature", input.sha);
    const fields = {
      lab: input.lab, name,
      qualification: input.qualification?.trim() || null, registration: input.registration?.trim() || null,
      title: input.title?.trim() || null, role: (input.role as ExternalSignatoryRole) || null,
    };
    const all = await this.repos.externalSignatories.listForOrg(actor.orgId);
    const bySha = all.find((r) => r.sha.includes(input.sha));
    const samePerson = all.find((r) => r.lab === input.lab && normName(r.name) === normName(name) && (r.registration ?? "") === (fields.registration ?? ""));
    const target = bySha ?? samePerson;
    let out: ExternalSignatory;
    if (target) {
      out = (await this.repos.externalSignatories.update(target.id, {
        ...fields,
        sha: [...new Set([...target.sha, input.sha])],
        dhash: [...new Set([...target.dhash, ...(seen.dhash ? [seen.dhash] : [])])],
        verifiedBy: actor.userId,
      }))!;
    } else {
      out = await this.repos.externalSignatories.create({ orgId: actor.orgId, ...fields, sha: [input.sha], dhash: seen.dhash ? [seen.dhash] : [], createdBy: actor.userId, verifiedBy: null });
    }
    await this.repos.audit.log({ orgId: actor.orgId, userId: actor.userId, action: target ? "external_signatory.update" : "external_signatory.create", entity: "external_signatory", entityId: out.id });
    await this.queue().reextract({ kind: "reextract", actor, sha: input.sha });
    return out;
  }

  /** Re-reads (from the stored PDFs) the organisation's imports in status extracted or matched that carry this signature. */
  async reextractSignature(actor: Actor, sha: string): Promise<number> {
    const rows = await this.repos.externalSignatures.find({ orgId: actor.orgId, sha } as never, { limit: 500 });
    const known = knownSignatures(await this.repos.externalSignatories.listForOrg(actor.orgId));
    let updated = 0;
    for (const id of new Set(rows.map((r) => r.externalReportId))) {
      const ext = await this.repos.externalReports.get(id);
      if (!ext || ext.orgId !== actor.orgId || (ext.status !== "extracted" && ext.status !== "matched")) continue;
      const file = await this.repos.externalReportFiles.get(ext.id);
      if (!file) continue;
      const { report } = await extractReport(new Uint8Array(file.pdf), { file: ext.fileName ?? undefined, signatures: known, signatureImages: false });
      const booking = ext.bookingId ? await this.repos.bookings.get(ext.bookingId) : null;
      const warnings = [...report.warnings, ...(booking ? await this.bookingWarnings(report, booking) : [])];
      await this.repos.externalReports.update(ext.id, { extracted: report as unknown as Record<string, unknown>, warnings });
      updated++;
    }
    return updated;
  }
}
