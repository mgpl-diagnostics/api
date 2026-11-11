import type { Booking, ExternalLabId, ExternalReport, ExternalReportStatus, ExternalSignatory, Report, ReportProvenance, ResultValue } from "@mgpl-diagnostics/db-kit";
import { provenanceText } from "@mgpl-diagnostics/report-kit";
import { labelFor, type ExtractedReport, type TestSection } from "@mgpl-diagnostics/report-reader";
import type { RequestContext as Ctx } from "../graphql/context";
import { badInput, withErrorCodes } from "../graphql/errors";
import { actorOf, authorize, branchScope, canSee, cap } from "../graphql/guards";
import { placeOf, printedProvenance, suggestTestCode, type SignatoryInput, type TestMapping } from "../services/import.service";
import { flagOut } from "./lab.controller";

const extractedOf = (e: ExternalReport) => e.extracted as unknown as ExtractedReport;
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

/** Offset cursors ("o:<n>", base64url). */
const cursor = (n: number) => Buffer.from(`o:${n}`).toString("base64url");
function offsetOf(after?: string | null): number {
  if (!after) return 0;
  const m = /^o:(\d{1,7})$/.exec(Buffer.from(after, "base64url").toString());
  if (!m) throw badInput("after is not a cursor from this list");
  return Number(m[1]);
}

async function importFor(ctx: Ctx, id: string, permission = "report:import") {
  const ext = await ctx.services.imports.get(actorOf(ctx), id);
  authorize(ctx, permission, ext.branchId);
  return ext;
}

async function bookingFor(ctx: Ctx, id: string, permission: string): Promise<Booking> {
  const b = await ctx.services.bookings.get(actorOf(ctx), id);
  authorize(ctx, permission, b.branchId);
  return b;
}

/** The printed provenance line for one partner test (the same words report-kit prints). */
function labelOf(report: ExtractedReport, test: TestSection) {
  const l = labelFor(report, test);
  const accreditationText = l.accreditation ? `NABL accredited laboratory${l.accreditation.certificate ? ` (Certificate No. ${l.accreditation.certificate})` : ""}` : null;
  return {
    performedBy: l.performedBy,
    performedAt: placeOf(l.performedBy, l.performedAt),
    accreditationText,
    reportedBy: l.reportedBy,
    text: provenanceText({ performedBy: l.performedBy, performedAt: placeOf(l.performedBy, l.performedAt) ?? undefined, ...(accreditationText ? { accreditationText } : {}), reportedBy: l.reportedBy.filter((r) => r.name).map((r) => ({ name: r.name! })) }),
  };
}

const resultsOut = (rs: ResultValue[]) => rs.map((x) => ({ ...x, flag: flagOut(x.flag) }));

/** Partner-lab imports (report-reader → db-kit), permissions report:import and signatory:read|manage per branch. */
export const importsController = withErrorCodes({
  Query: {
    externalReport: (_: unknown, a: { id: string }, ctx: Ctx) => importFor(ctx, a.id, "report:import"),
    externalReports: async (_: unknown, a: { branchId?: string | null; bookingId?: string | null; status?: ExternalReportStatus | null; first?: number | null; after?: string | null }, ctx: Ctx) => {
      const scope = branchScope(ctx, "report:import", a.branchId);
      if (a.bookingId) await bookingFor(ctx, a.bookingId, "report:import");
      const limit = cap(a.first, 50);
      const offset = offsetOf(a.after);
      const rows = await ctx.services.imports.list(actorOf(ctx), { scope, bookingId: a.bookingId, status: a.status, limit, offset });
      const nodes = rows.slice(0, limit);
      const hasNextPage = rows.length > limit;
      return { nodes, pageInfo: { hasNextPage, endCursor: hasNextPage ? cursor(offset + limit) : null } };
    },
    externalSignatories: (_: unknown, a: { lab?: ExternalLabId | null }, ctx: Ctx) => ctx.services.imports.signatories(authorize(ctx, "signatory:read"), a.lab),
  },

  Mutation: {
    importExternalReport: async (_: unknown, a: { pdfBase64: string; fileName?: string | null; bookingId?: string | null; branchId?: string | null }, ctx: Ctx) => {
      const actor = actorOf(ctx);
      const b64 = a.pdfBase64.replace(/\s+/g, "");
      const bytes = Math.floor((b64.length * 3) / 4) - (b64.endsWith("==") ? 2 : b64.endsWith("=") ? 1 : 0);
      ctx.services.imports.assertSize(bytes);
      if (!BASE64.test(b64)) throw badInput("pdfBase64 is not base64");
      const booking = a.bookingId ? await ctx.services.bookings.get(actor, a.bookingId) : null;
      const branchId = booking?.branchId ?? a.branchId;
      if (!branchId) throw badInput("branchId is required when there is no bookingId");
      if (booking && a.branchId && a.branchId !== booking.branchId) throw badInput("The booking belongs to another branch");
      authorize(ctx, "report:import", branchId);
      const pdf = new Uint8Array(Buffer.from(b64, "base64"));
      // the same PDF imported before: return it only to someone allowed to see it there
      const before = await ctx.services.imports.existing(actor, pdf);
      if (before) return (authorize(ctx, "report:import", before.branchId), before);
      return ctx.services.imports.import(actor, { pdf, fileName: a.fileName?.slice(0, 200) ?? null, branchId, bookingId: booking?.id ?? null });
    },
    matchExternalReport: async (_: unknown, a: { id: string; bookingId: string }, ctx: Ctx) => {
      const ext = await importFor(ctx, a.id);
      const booking = await bookingFor(ctx, a.bookingId, "report:import");
      return ctx.services.imports.match(actorOf(ctx), ext, booking);
    },
    applyExternalReport: async (_: unknown, a: { id: string; mappings: TestMapping[]; confirmPatientMismatch?: boolean | null }, ctx: Ctx) => {
      const ext = await importFor(ctx, a.id);
      if (!ext.bookingId) throw badInput("Match the partner report to a booking first (matchExternalReport)");
      // applying enters results: the same permission as typing them in
      const booking = await bookingFor(ctx, ext.bookingId, "report:enter");
      authorize(ctx, "report:import", booking.branchId);
      return ctx.services.imports.apply(actorOf(ctx), ext, booking, a.mappings, a.confirmPatientMismatch === true);
    },
    rejectExternalReport: async (_: unknown, a: { id: string; reason: string }, ctx: Ctx) => ctx.services.imports.reject(actorOf(ctx), await importFor(ctx, a.id, "report:import"), a.reason),
    nameExternalSignature: (_: unknown, { input }: { input: SignatoryInput }, ctx: Ctx) => ctx.services.imports.nameSignature(authorize(ctx, "signatory:manage"), input),
  },

  ExternalReport: {
    booking: (e: ExternalReport, _: unknown, ctx: Ctx) => ctx.loaders.booking.load(e.bookingId),
    patientMismatches: (e: ExternalReport, _: unknown, ctx: Ctx) => ctx.services.imports.mismatches(e),
    patient: (e: ExternalReport) => extractedOf(e).patient ?? {},
    sampleIds: (e: ExternalReport) => extractedOf(e).sample?.sampleIds ?? [],
    reportedAt: (e: ExternalReport) => extractedOf(e).dates?.reported ?? null,
    candidates: (e: ExternalReport, a: { first?: number | null }, ctx: Ctx) =>
      e.status === "applied" || e.status === "rejected" ? [] : ctx.services.imports.candidates(actorOf(ctx), e, branchScope(ctx, "report:import"), Math.min(cap(a.first, 5), 10)),
    tests: async (e: ExternalReport, _: unknown, ctx: Ctx) => {
      const r = extractedOf(e);
      const booking = e.bookingId ? await ctx.loaders.booking.load(e.bookingId) : null;
      const codes = booking?.tests.map((t) => t.testCode);
      return r.tests.map((t, index) => ({
        ...t,
        index,
        accredited: t.accredited === true,
        parameters: t.parameters.map((p) => ({ ...p, flag: flagOut(p.flag) })),
        suggestedTestCode: suggestTestCode(t.name, codes),
        provenance: labelOf(r, t),
      }));
    },
    signatories: (e: ExternalReport) => extractedOf(e).signatories.map((s) => ({ ...s, sha: s.signature.sha, _ext: e })),
    reports: (e: ExternalReport, _: unknown, ctx: Ctx) => (canSee(ctx, "report:read", e.branchId) ? ctx.services.imports.reportsOf(e) : []),
    uploadedBy: (e: ExternalReport, _: unknown, ctx: Ctx) => ctx.loaders.user.load(e.uploadedBy),
  },
  ExternalSignatoryOnReport: {
    // rule: a partner signature is only served with the results of its own PDF (orgId + that PDF's sha256 + image sha)
    image: async (s: { sha: string; _ext: ExternalReport }, _: unknown, ctx: Ctx) => {
      const img = await ctx.services.imports.signatureImage(s._ext.orgId, s._ext.sourceSha256, s.sha);
      return img ? { mimeType: "image/png", width: img.width, height: img.height, base64: Buffer.from(img.png).toString("base64") } : null;
    },
  },
  ExternalSignatory: {
    signatureCount: (s: ExternalSignatory) => s.sha.length,
  },
  ReportProvenance: {
    accreditationText: (p: ReportProvenance) => printedProvenance(p).accreditationText ?? null,
    reportedBy: (p: ReportProvenance) => p.reportedBy.map((r) => ({ ...r, id: r.signatoryId })),
    importedResults: (p: ReportProvenance) => resultsOut(p.importedResults),
    appliedAt: (p: ReportProvenance) => p.createdAt,
  },
  Report: {
    provenance: (r: Report, _: unknown, ctx: Ctx) => (canSee(ctx, "report:read", r.branchId) ? ctx.loaders.provenance.load(r.id) : null),
  },
});

