// Partner-lab imports end to end (report-reader → db-kit → GraphQL → report-kit), on each backend.
// The PDFs are fictional and drawn at test time (test/partner-pdfs.ts).
import { PDFDocument, StandardFonts } from "pdf-lib";
import type { Repositories } from "@mgpl-diagnostics/db-kit";
import type { Services } from "../src/services";
import { clinovaPdf, hypathoPdf } from "./partner-pdfs";

type Gql = { data?: any; errors?: { message: string; extensions?: Record<string, any> }[] };
type Run = (token: string | null, query: string, variables?: Record<string, unknown>) => Promise<Gql>;
type Ok = (cond: unknown, msg: string) => void;

const code = (r: Gql) => r.errors?.[0]?.extensions?.code;
const b64 = (b: Uint8Array) => Buffer.from(b).toString("base64");

const EXT = `id status lab labName branchId fileName warnings patientMismatches sourceSha256 booking { id }
  patient { name ageYears sex } sampleIds
  tests { index name accredited suggestedTestCode parameters { name value unit range flag } provenance { performedBy accreditationText reportedBy { name } text } }
  signatories { id name role medical source sha image { mimeType width height base64 } }`;
const IMPORT = `mutation($pdf: String!, $f: String, $b: ID, $br: ID) { importExternalReport(pdfBase64: $pdf, fileName: $f, bookingId: $b, branchId: $br) { ${EXT} } }`;

export interface ImportCtx {
  tag: string;
  gql: Run;
  ok: Ok;
  owner: string;
  otherOwner: string;
  login: (email: string, password?: string) => Promise<string>;
  branchA: string;
  branchB: string;
  orgId: string;
  repos: Repositories;
  services: Services;
  /** Sends a raw body (for the size limits). */
  raw: (token: string, body: string) => Promise<{ status: number; json: Gql }>;
}

async function unsupportedPdf() {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  doc.addPage().drawText("Fictional letter, not a lab report", { x: 50, y: 700, size: 12, font });
  return doc.save();
}

export async function importSuite(c: ImportCtx) {
  const { tag, gql, ok, owner, otherOwner } = c;
  const t = (s: string) => `[${tag}] imports: ${s}`;

  // users: a technician in branch A (report:import, signatory:read) and a front desk (neither)
  const pw = "Counter-Shift-7391";
  for (const [email, role] of [["tech@apl.test", "technician"], ["desk2@apl.test", "front_desk"]] as const)
    await gql(owner, "mutation($i: CreateUserInput!) { createUser(input: $i) { id } }", { i: { name: role, email, password: pw, roles: [{ role, branchId: c.branchA }] } });
  const tech = await c.login("tech@apl.test", pw);
  const desk = await c.login("desk2@apl.test", pw);

  // a booking for the Clinova patient (Mr DEMO PERSON, 35, male): lipid profile + ESR
  const patientId = (await gql(owner, "mutation($i: RegisterPatientInput!) { registerPatient(input: $i) { id } }", { i: { branchId: c.branchA, title: "Mr", name: "Demo Person", sex: "male", ageYears: 35 } })).data?.registerPatient.id;
  const booking = (await gql(owner, "mutation($i: CreateBookingInput!) { createBooking(input: $i) { booking { id bookingNo } } }", { i: { branchId: c.branchA, patientId, tests: [{ testCode: "LIPR" }, { testCode: "ESR" }] } })).data?.createBooking.booking;
  ok(!!booking?.id, t("booking for the partner patient"));

  // ------------------------------------------------------------ permissions and validation
  const clinova = await clinovaPdf();
  ok(code(await gql(desk, IMPORT, { pdf: b64(clinova), b: booking.id })) === "FORBIDDEN", t("front desk cannot import (report:import) → FORBIDDEN"));
  ok(code(await gql(tech, IMPORT, { pdf: b64(clinova), br: c.branchB })) === "FORBIDDEN", t("a technician of branch A cannot import into branch B"));
  ok(code(await gql(tech, IMPORT, { pdf: b64(clinova) })) === "BAD_USER_INPUT", t("no booking and no branch → BAD_USER_INPUT"));
  ok(code(await gql(otherOwner, IMPORT, { pdf: b64(clinova), b: booking.id })) === "NOT_FOUND", t("another organisation's booking → NOT_FOUND"));
  const unsupported = await gql(tech, IMPORT, { pdf: b64(await unsupportedPdf()), br: c.branchA });
  ok(code(unsupported) === "UNSUPPORTED_REPORT", t("a PDF from an unknown lab → UNSUPPORTED_REPORT"));
  ok((await c.repos.externalReportFiles.find({ orgId: c.orgId } as never)).length === 0, t("…and its file is not kept"));
  ok(code(await gql(tech, IMPORT, { pdf: "not base64!", br: c.branchA })) === "BAD_USER_INPUT", t("pdfBase64 that is not base64 → BAD_USER_INPUT"));

  // ------------------------------------------------------------ import + re-import (Clinova: printed names, NABL on one test)
  const imp = await gql(tech, IMPORT, { pdf: b64(clinova), f: "clinova-demo.pdf", b: booking.id });
  const ext = imp.data?.importExternalReport;
  ok(ext?.status === "matched" && ext.lab === "clinova" && ext.booking.id === booking.id && ext.branchId === c.branchA, t(`importExternalReport (with bookingId) → matched, ${ext?.tests.length} tests`));
  ok(ext?.patientMismatches.length === 0 && ext.patient.name, t("same patient (title, case ignored; age ±1) → no mismatch"));
  const lipid = ext?.tests.find((x: any) => /lipid/i.test(x.name));
  const esr = ext?.tests.find((x: any) => /ESR|sedimentation/i.test(x.name));
  ok(lipid?.suggestedTestCode === "LIPR" && esr?.suggestedTestCode === "ESR", t("catalog-kit suggests LIPR and ESR"));
  ok(lipid?.accredited === true && /NABL accredited laboratory \(Certificate No\. MC-9999\)/.test(lipid.provenance.accreditationText ?? "") && lipid.provenance.text.includes("NABL"), t("NABL line on the accredited test, as the partner's accreditation"));
  ok(esr?.accredited === false && esr.provenance.accreditationText === null && !esr.provenance.text.includes("NABL"), t("…and no NABL line on the test that is not accredited"));
  const medical = ext?.signatories.filter((s: any) => s.medical) ?? [];
  ok(medical.length === 1 && ext.signatories.length === 2 && lipid.provenance.reportedBy.length === 1 && lipid.provenance.reportedBy[0].name === medical[0].name, t("Reported by lists the medical signatory only (not the lab manager)"));
  ok(ext?.signatories.every((s: any) => s.image?.mimeType === "image/png" && Buffer.from(s.image.base64, "base64").subarray(1, 4).toString() === "PNG"), t("signature images served as PNG with their own PDF"));
  const again = await gql(tech, IMPORT, { pdf: b64(clinova), b: booking.id });
  ok(again.data?.importExternalReport.id === ext?.id, t("the same PDF again → the same import"));
  ok((await gql(tech, "query($b: ID!) { externalReports(bookingId: $b) { nodes { id } pageInfo { hasNextPage } } }", { b: booking.id })).data?.externalReports.nodes.length === 1, t("externalReports(bookingId) lists it once"));
  ok(code(await gql(otherOwner, `query($id: ID!) { externalReport(id: $id) { id } }`, { id: ext?.id })) === "NOT_FOUND", t("another organisation → NOT_FOUND"));
  ok(code(await gql(desk, `query($id: ID!) { externalReport(id: $id) { id } }`, { id: ext?.id })) === "FORBIDDEN", t("externalReport needs report:import"));

  // ------------------------------------------------------------ Hy Patho: unnamed signatures, patient mismatch
  const hy = await gql(tech, IMPORT, { pdf: b64(await hypathoPdf()), br: c.branchA });
  const hext = hy.data?.importExternalReport;
  ok(hext?.status === "extracted" && hext.lab === "hypatho" && hext.signatories.length >= 1 && hext.signatories.every((s: any) => s.name === null && s.source === "unknown"), t("Hy Patho import: signatures not yet named"));
  ok(hext?.tests.every((x: any) => x.accredited === false && x.provenance.accreditationText === null), t("Hy Patho carries no marks → no NABL line"));
  const matched = await gql(tech, "mutation($id: ID!, $b: ID!) { matchExternalReport(id: $id, bookingId: $b) { status patientMismatches warnings } }", { id: hext?.id, b: booking.id });
  const mm = matched.data?.matchExternalReport.patientMismatches ?? [];
  ok(mm.some((m: string) => /name/.test(m)) && mm.some((m: string) => /age 40/.test(m)), t(`matching another patient's booking → warnings (${mm.length})`));
  const applyHy = await gql(tech, "mutation($id: ID!, $m: [ExternalTestMappingInput!]!) { applyExternalReport(id: $id, mappings: $m) { id } }", { id: hext?.id, m: [{ testIndex: 0, testCode: "ESR" }] });
  ok(code(applyHy) === "BOOKING_PATIENT_MISMATCH" && applyHy.errors?.[0]?.extensions?.mismatches?.length === mm.length, t("apply without confirmation → BOOKING_PATIENT_MISMATCH"));
  ok((await gql(tech, "mutation($id: ID!) { rejectExternalReport(id: $id, reason: \"Wrong patient\") { status } }", { id: hext?.id })).data?.rejectExternalReport.status === "rejected", t("rejectExternalReport"));

  // ------------------------------------------------------------ name a signature → re-extraction
  const sha = hext?.signatories[0]?.sha;
  const named = { sha, lab: "hypatho", name: "Dr Fictional Reader", qualification: "MD (Pathology)", registration: "XX-0001", role: "pathologist" };
  ok(code(await gql(tech, "mutation($i: ExternalSignatoryInput!) { nameExternalSignature(input: $i) { id } }", { i: named })) === "FORBIDDEN", t("nameExternalSignature needs signatory:manage"));
  ok(code(await gql(otherOwner, "mutation($i: ExternalSignatoryInput!) { nameExternalSignature(input: $i) { id } }", { i: named })) === "NOT_FOUND", t("…and a signature this organisation has seen"));
  // a second, unapplied import of a Hy Patho PDF carrying that signature (new bytes, same drawing)
  const hy2pdf = await PDFDocument.load(await hypathoPdf());
  hy2pdf.setTitle("copy");
  const hy2 = (await gql(tech, IMPORT, { pdf: b64(await hy2pdf.save()), br: c.branchA })).data?.importExternalReport;
  const sig = await gql(owner, "mutation($i: ExternalSignatoryInput!) { nameExternalSignature(input: $i) { id name signatureCount } }", { i: named });
  ok(sig.data?.nameExternalSignature.name === "Dr Fictional Reader" && sig.data.nameExternalSignature.signatureCount === 1, t("nameExternalSignature adds the registry entry"));
  const reread = (await gql(tech, `query($id: ID!) { externalReport(id: $id) { ${EXT} } }`, { id: hy2?.id })).data?.externalReport;
  ok(reread?.signatories.some((s: any) => s.name === "Dr Fictional Reader" && s.source === "registry" && s.medical) && reread.tests[0].provenance.reportedBy.some((r: any) => r.name === "Dr Fictional Reader"), t("unapplied imports carrying it are read again: named, Reported by"));
  const rejected = (await gql(tech, `query($id: ID!) { externalReport(id: $id) { signatories { name } } }`, { id: hext?.id })).data?.externalReport;
  ok(rejected?.signatories.every((s: any) => s.name === null), t("…a rejected import is left as it was"));
  ok((await gql(tech, "{ externalSignatories(lab: hypatho) { name } }")).data?.externalSignatories.length === 1 && code(await gql(desk, "{ externalSignatories { name } }")) === "FORBIDDEN", t("externalSignatories needs signatory:read"));

  // ------------------------------------------------------------ apply with provenance (status unchanged until staff verify)
  const mapping = [{ testIndex: lipid.index, testCode: "LIPR" }, { testIndex: esr.index, testCode: "ESR" }];
  ok(code(await gql(desk, "mutation($id: ID!, $m: [ExternalTestMappingInput!]!) { applyExternalReport(id: $id, mappings: $m) { id } }", { id: ext.id, m: mapping })) === "FORBIDDEN", t("front desk cannot apply"));
  ok(code(await gql(tech, "mutation($id: ID!, $m: [ExternalTestMappingInput!]!) { applyExternalReport(id: $id, mappings: $m) { id } }", { id: ext.id, m: [{ testIndex: 0, testCode: "CBC" }] })) === "BAD_USER_INPUT", t("a test that is not in the booking → BAD_USER_INPUT"));
  const applied = await gql(tech, "mutation($id: ID!, $m: [ExternalTestMappingInput!]!) { applyExternalReport(id: $id, mappings: $m) { id testCode status results { parameter value unit range flag } provenance { lab performedBy accreditationText reportedBy { name } sourceTestName importedResults { value } } } }", { id: ext.id, m: mapping });
  const reps = applied.data?.applyExternalReport ?? [];
  const lr = reps.find((r: any) => r.testCode === "LIPR");
  const er = reps.find((r: any) => r.testCode === "ESR");
  ok(reps.length === 2 && reps.every((r: any) => r.status === "entered"), t("applyExternalReport → our reports, status entered (not verified)"));
  const chol = lr?.results.find((x: any) => /cholesterol/i.test(x.parameter) && x.value === "245");
  ok(chol?.unit === "mg/dL" && /Desirable/.test(chol.range ?? "") && er?.results[0]?.range === "<= 20", t("values, units and ranges copied as printed"));
  ok(lr?.provenance?.lab === "clinova" && /MC-9999/.test(lr.provenance.accreditationText ?? "") && er?.provenance?.accreditationText === null && lr.provenance.reportedBy.length === 1, t("Report.provenance: lab, NABL only on the accredited test, medical signatory"));
  ok(code(await gql(tech, "mutation($id: ID!, $m: [ExternalTestMappingInput!]!) { applyExternalReport(id: $id, mappings: $m) { id } }", { id: ext.id, m: mapping })) === "REPORT_ALREADY_APPLIED", t("applying twice → REPORT_ALREADY_APPLIED"));
  ok(code(await gql(tech, "query($b: ID!) { bookingReportDocument(bookingId: $b) { fileName } }", { b: booking.id })) === "CONFLICT", t("imported results do not print until verified"));

  // edit after import: audited, no catalog defaults
  await gql(owner, "mutation($r: ID!, $x: [ResultInput!]!) { saveResults(reportId: $r, results: $x) { id } }", { r: er.id, x: [{ parameter: er.results[0].parameter, value: "31", unit: "mm/Hour", range: "<= 20" }] });
  const audit = await c.repos.audit.find({ orgId: c.orgId, action: "report.edit_imported" } as never);
  ok(audit.length === 1 && JSON.stringify(audit[0]).includes(er.results[0].parameter) && !JSON.stringify(audit[0]).includes("\"31\""), t("editing imported results is audited (parameter names, no values)"));

  for (const r of reps) await gql(owner, "mutation($r: ID!) { verifyReport(id: $r) { status } }", { r: r.id });
  const html = (await gql(tech, "query($b: ID!) { bookingReportDocument(bookingId: $b, format: html) { html } }", { b: booking.id })).data?.bookingReportDocument.html ?? "";
  const pdf = await gql(tech, "query($b: ID!) { bookingReportDocument(bookingId: $b) { base64 } }", { b: booking.id });
  const printed = html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
  ok(/Performed at Clinova Pathlabs, Demo Central Lab/.test(printed) && /NABL accredited laboratory \(Certificate No\. MC-9999\)/.test(printed) && Buffer.from(pdf.data?.bookingReportDocument.base64 ?? "", "base64").subarray(0, 5).toString() === "%PDF-", t("verified → prints with the per-test provenance line (HTML + PDF)"));
  ok((printed.match(/NABL accredited/g) ?? []).length === 1 && !/<img[^>]+nabl/i.test(html), t("NABL text once (the accredited test only), never a logo"));
  ok(/class="sb-psign"/.test(html) && /class="sb-psignimg"[^>]*src="data:image\/png;base64|src="data:image\/png;base64[^"]*"[^>]*class="sb-psignimg"/.test(html) && !/class="sb-signimg"/.test(html), t("the partner's medical signatory and signature print with its own results"));

  // ------------------------------------------------------------ a signature only appears with results from its own PDF
  const csha = ext.signatories.find((s: any) => s.medical).sha;
  ok(!!(await c.services.imports.signatureImage(c.orgId, ext.sourceSha256, csha)) && (await c.services.imports.signatureImage(c.orgId, hext.sourceSha256, csha)) === null, t("signature lookup is keyed by its own PDF's sha256"));
  ok((await c.services.imports.signatureImage(c.orgId, ext.sourceSha256, "")) === null, t("…never by an empty sha"));
  // our own booking with typed-in results prints our signatory, never a stored partner signature
  const own = (await gql(owner, "mutation($i: CreateBookingInput!) { createBooking(input: $i) { booking { id } } }", { i: { branchId: c.branchA, patientId, tests: [{ testCode: "ESR" }] } })).data?.createBooking.booking;
  const ownRep = (await gql(owner, 'mutation($b: ID!) { createReport(bookingId: $b, testCode: "ESR") { id } }', { b: own.id })).data?.createReport.id;
  await gql(owner, "mutation($r: ID!, $x: [ResultInput!]!) { saveResults(reportId: $r, results: $x) { id } }", { r: ownRep, x: [{ parameter: "Erythrocyte Sedimentation Rate (ESR)", value: "12" }] });
  await gql(owner, "mutation($r: ID!) { verifyReport(id: $r) { id } }", { r: ownRep });
  const ownHtml = (await gql(owner, "query($b: ID!) { bookingReportDocument(bookingId: $b, format: html) { html } }", { b: own.id })).data?.bookingReportDocument.html ?? "";
  ok(ownHtml.includes("<html") && !/class="sb-psign|Performed at|Clinova/.test(ownHtml), t("a report we performed prints no partner provenance or signature"));

  // ------------------------------------------------------------ size limits
  const big = await c.raw(tech, JSON.stringify({ query: IMPORT, variables: { pdf: "A".repeat(Math.ceil((15 * 1024 * 1024 + 4096) / 3) * 4), br: c.branchA } }));
  ok(code(big.json) === "FILE_TOO_LARGE" && big.json.errors?.[0]?.extensions?.maxBytes === 15 * 1024 * 1024, t("a PDF over 15 MB → FILE_TOO_LARGE"));
  const padded = await c.raw(tech, JSON.stringify({ query: "{ health { ok } }", variables: { pad: "x".repeat(3_000_000) } }));
  ok(padded.status === 413 && code(padded.json) === "FILE_TOO_LARGE", t("other operations keep the 2 MB body limit"));
}
