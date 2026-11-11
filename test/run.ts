// End-to-end tests: the real server (Fastify + Yoga) over HTTP inject, real auth-kit sessions, real
// databases started in-process: PostgreSQL always, MongoDB (replica set) unless TEST_BACKENDS=pg.
//   npm test                     both backends (first run downloads the database binaries)
//   TEST_BACKENDS=pg npm test    PostgreSQL only (when MongoDB binaries cannot be downloaded)
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hashPassword, hashTlsFingerprint, SYSTEM_ROLES } from "@mgpl-diagnostics/auth-kit";
import { createDb, seedOrganization, type Db, type Repositories } from "@mgpl-diagnostics/db-kit";
import { financePosting, istDay } from "@mgpl-diagnostics/finance-kit";
import { createMgplGraphQLClient, createSessionManager, OPERATIONS } from "@mgpl-diagnostics/client";
import { parse, validate } from "graphql";
import { Redis } from "ioredis";
import { QueryTypes, Sequelize } from "sequelize";
import { loadConfig } from "../src/config/env";
import { withCatalogDefaults } from "../src/services/report.service";
import { TESTS } from "@mgpl-diagnostics/catalog-kit";
import { buildSchema } from "../src/graphql/schema";
import { createContainer } from "../src/container";
import { buildServer } from "../src/server";
import { shutdown } from "../src/lifecycle";
import { startWorkers } from "../src/jobs";
import type { Mailer } from "../src/services/auth.service";
import { createMailer, memoryTransport } from "@mgpl-diagnostics/mail-kit";
import { MGPL_LAB } from "@mgpl-diagnostics/report-kit";
import { brandFromLab, mailerFromConfig, mailKitMailer } from "../src/jobs";
import { importSuite } from "./imports";
import { clinovaPdf } from "./partner-pdfs";
import { PDFDocument } from "pdf-lib";
import { SystemService } from "../src/services/system.service";

let passed = 0;
let failed = 0;
const ok = (cond: unknown, msg: string) => {
  if (cond) passed++;
  else failed++;
  console.log(`${cond ? "✓" : "✗"} ${msg}`);
};

type Gql = { data?: any; errors?: { message: string; extensions?: { code?: string } }[] };
const code = (r: Gql) => r.errors?.[0]?.extensions?.code;

async function suite(db: Db, tag: string) {
  console.log(`\n[${tag}]`);
  // count batched patient lookups (N+1 check) on the repositories the services use
  let patientBatches = 0;
  const repos: Repositories = { ...db.repos, patients: { ...db.repos.patients, getMany: (ids) => { patientBatches++; return db.repos.patients.getMany(ids); } } };
  const mails: { to: string; link: string }[] = [];
  const mailer: Mailer = { passwordReset: async (to, link) => void mails.push({ to: to.email, link }) };
  const config = { ...loadConfig({ NODE_ENV: "test", MGPL_SAMPLES: "1", INTROSPECTION: "0", DATABASE_URL: "unused" }) };
  const container = await createContainer({ config, db: { ...db, repos }, mailer });
  const app = await buildServer(container);

  const gql = async (token: string | null, query: string, variables?: Record<string, unknown>): Promise<Gql> => {
    const res = await app.inject({ method: "POST", url: "/graphql", headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, payload: JSON.stringify({ query, variables }) });
    const out = res.json() as Gql;
    if (process.env.DEBUG && out.errors) console.log("   ", JSON.stringify(out.errors).slice(0, 400));
    return out;
  };

  // ---------------------------------------------------------------- setup: two organisations, auth-kit roles
  const pw = "Lab-Owner-2026!";
  const a = await seedOrganization(db.rawRepos, { org: { name: "API Lab", code: "APL", gstin: "22AAAAA0000A1Z5" }, branch: { code: "A01", name: "Branch A", stateCode: "22" }, owner: { name: "Owner", email: "owner@apl.test", passwordHash: await hashPassword(pw) }, roles: SYSTEM_ROLES });
  const other = await seedOrganization(db.rawRepos, { org: { name: "Other Lab", code: "OTH" }, branch: { code: "Z01", name: "Z", stateCode: "22" }, owner: { name: "X", email: "x@oth.test", passwordHash: await hashPassword(pw) }, roles: SYSTEM_ROLES });

  const health = await app.inject({ url: "/health" });
  ok(health.statusCode === 200 && (await gql(null, "{ health { ok database } }")).data?.health.ok, `[${tag}] GET /health and { health } report the database`);
  ok(code(await gql(null, "{ organization { name } }")) === "UNAUTHENTICATED", `[${tag}] no token → UNAUTHENTICATED`);
  ok(code(await gql(null, 'mutation { login(input: { email: "owner@apl.test", password: "wrong-password" }) { token } }')) === "INVALID_CREDENTIALS", `[${tag}] wrong password → INVALID_CREDENTIALS`);
  const login = async (email: string, password = pw) => (await gql(null, "mutation($i: LoginInput!) { login(input: $i) { accessToken user { email } } }", { i: { email, password } })).data?.login.accessToken as string;
  const owner = await login("owner@apl.test");
  const otherOwner = await login("x@oth.test");
  ok(typeof owner === "string" && owner.split(".").length === 3, `[${tag}] login → access token (JWT)`);
  const viewer = await gql(owner, '{ viewer { user { email } organization { code } can(permission: "accounts:post") branchesFor(permission: "invoice:read") } }');
  ok(viewer.data?.viewer.user.email === "owner@apl.test" && viewer.data.viewer.organization.code === "APL" && viewer.data.viewer.can && viewer.data.viewer.branchesFor === null, `[${tag}] viewer: user, organisation, permissions`);
  ok((await gql(null, "{ viewer { user { id } } }")).data?.viewer === null, `[${tag}] viewer is null without a token`);

  const chart = await gql(owner, "mutation { setupChartOfAccounts { name systemKey } }");
  ok(chart.data?.setupChartOfAccounts.length > 10, `[${tag}] setupChartOfAccounts (ledger-kit chart + finance-kit ledgers): ${chart.data?.setupChartOfAccounts.length} ledgers`);
  await gql(otherOwner, "mutation { setupChartOfAccounts { id } }");
  const branchB = (await gql(owner, 'mutation { createBranch(input: { code: "b01", name: "Branch B", kind: collection_center, stateCode: "22" }) { id code } }')).data?.createBranch;
  ok(branchB?.code === "B01", `[${tag}] createBranch (code upper-cased)`);
  const deskUser = await gql(owner, "mutation($i: CreateUserInput!) { createUser(input: $i) { id roles { role branch { code } } } }", {
    i: { name: "Desk", email: "desk@apl.test", password: "Counter-Shift-7391", roles: [{ role: "front_desk", branchId: a.branch.id }] },
  });
  ok(deskUser.data?.createUser.roles[0].branch.code === "A01", `[${tag}] createUser with a branch role (auth-kit hashes the password)`);
  ok(code(await gql(owner, "mutation($i: CreateUserInput!) { createUser(input: $i) { id } }", { i: { name: "W", email: "w@apl.test", password: "password", roles: [{ role: "front_desk" }] } })) === "WEAK_PASSWORD", `[${tag}] weak password → WEAK_PASSWORD`);
  const desk = await login("desk@apl.test", "Counter-Shift-7391");

  // ---------------------------------------------------------------- no privilege escalation through user management
  await gql(owner, 'mutation { upsertRole(input: { key: "user_manager", name: "User manager", permissions: ["user:read", "user:create", "user:update", "role:read"] }) { key } }');
  await gql(owner, 'mutation { upsertRole(input: { key: "user_viewer", name: "User viewer", permissions: ["user:read"] }) { key } }');
  await gql(owner, "mutation($i: CreateUserInput!) { createUser(input: $i) { id } }", { i: { name: "Manager", email: "um@apl.test", password: "Counter-Shift-7391", roles: [{ role: "user_manager" }] } });
  const um = await login("um@apl.test", "Counter-Shift-7391");
  const umId = (await gql(um, "{ viewer { user { id } } }")).data?.viewer.user.id;
  const mint = await gql(um, "mutation($i: CreateUserInput!) { createUser(input: $i) { id } }", { i: { name: "Mint", email: "mint@apl.test", password: "Counter-Shift-7391", roles: [{ role: "owner" }] } });
  const self = await gql(um, "mutation($u: ID!) { setUserRoles(userId: $u, roles: [{ role: \"owner\" }]) { id } }", { u: umId });
  const ownerId = (await gql(owner, "{ viewer { user { id } } }")).data?.viewer.user.id;
  const takeover = await gql(um, "mutation($u: ID!) { setUserPassword(userId: $u, newPassword: \"Granite-Orbit-4471\") }", { u: ownerId });
  ok(code(mint) === "FORBIDDEN" && code(self) === "FORBIDDEN" && code(takeover) === "FORBIDDEN", `[${tag}] a custom role with user:create / user:update cannot mint an owner, promote itself, or set the owner's password`);
  ok(!!(await gql(um, "mutation($i: CreateUserInput!) { createUser(input: $i) { id } }", { i: { name: "Viewer", email: "uv@apl.test", password: "Counter-Shift-7391", roles: [{ role: "user_viewer" }] } })).data?.createUser.id, `[${tag}] …but can grant a role whose permissions it holds`);
  ok(code(await gql(um, 'mutation { upsertRole(input: { key: "x_all", name: "X", permissions: ["*:*"] }) { key } }')) === "FORBIDDEN", `[${tag}] upsertRole needs role:manage`);

  // ---------------------------------------------------------------- catalog (public)
  const cat = await gql(null, '{ catalogSearch(query: "cbc", limit: 3) { test { code name pricePaise sampleType parameters { name unit range(sex: male) } } } priceQuote(tests: ["CBC", "NOPE"]) { total totalPaise unknown } }');
  const cbc = cat.data?.catalogSearch[0]?.test;
  ok(cbc?.code === "CBC" && cbc.pricePaise === 39900 && cat.data.priceQuote.unknown[0] === "NOPE", `[${tag}] catalog search + price quote (catalog-kit, no sign-in)`);

  // ---------------------------------------------------------------- lab workflow
  const reg = await gql(owner, "mutation($i: RegisterPatientInput!) { registerPatient(input: $i) { id uhid name } }", { i: { branchId: a.branch.id, name: "Asha Patel", sex: "female", ageYears: 29, phone: "9111111111" } });
  const patientId = reg.data?.registerPatient.id;
  ok(reg.data?.registerPatient.uhid === "APL-000001", `[${tag}] registerPatient → ${reg.data?.registerPatient.uhid}`);
  const book = await gql(owner, "mutation($i: CreateBookingInput!) { createBooking(input: $i) { booking { id bookingNo tests { testCode name pricePaise sampleType catalog { department } } } samples { id barcode sampleType } } }", {
    i: { branchId: a.branch.id, patientId, tests: [{ testCode: "CBC" }] },
  });
  const booking = book.data?.createBooking;
  ok(booking?.booking.tests[0].name === "Complete Blood Count (CBC)" && booking.booking.tests[0].pricePaise === 39900 && booking.samples.length === 1, `[${tag}] createBooking by catalog code: name, price and sample type from catalog-kit`);
  ok((await gql(owner, "mutation($id: ID!) { collectSample(id: $id) { status } }", { id: booking.samples[0].id })).data?.collectSample.status === "collected", `[${tag}] collectSample`);
  ok((await gql(owner, "mutation($id: ID!) { receiveSample(id: $id) { status booking { status } } }", { id: booking.samples[0].id })).data?.receiveSample.booking.status === "in_process", `[${tag}] receiveSample → booking in process`);
  const rep = await gql(owner, 'mutation($b: ID!) { createReport(bookingId: $b, testCode: "CBC") { id status testName } }', { b: booking.booking.id });
  const reportId = rep.data?.createReport.id;
  const saved = await gql(owner, "mutation($r: ID!, $x: [ResultInput!]!) { saveResults(reportId: $r, results: $x) { status results { parameter value unit flag range } } }", {
    r: reportId, x: [{ parameter: "Hemoglobin", value: "10.2" }, { parameter: "Total Leucocytes Count", value: "7.5" }],
  });
  const hb = saved.data?.saveResults.results[0];
  ok(hb?.unit === "g/dL" && hb.flag === "L" && saved.data.saveResults.results[1].flag === "NONE", `[${tag}] saveResults: unit, range and flag filled from catalog-kit (Hb 10.2 → L)`);
  ok(code(await gql(owner, "query($b: ID!) { bookingReportDocument(bookingId: $b) { fileName } }", { b: booking.booking.id })) === "CONFLICT", `[${tag}] an unverified report does not print → CONFLICT`);
  await gql(owner, "mutation($r: ID!) { verifyReport(id: $r) { status } }", { r: reportId });
  const released = await gql(owner, "mutation($r: ID!) { releaseReport(id: $r) { status booking { status } } }", { r: reportId });
  ok(released.data?.releaseReport.booking.status === "completed", `[${tag}] verify + release → booking completed`);
  const doc = await gql(owner, "query($b: ID!) { bookingReportDocument(bookingId: $b) { format fileName mimeType byteLength base64 } }", { b: booking.booking.id });
  const pdf = Buffer.from(doc.data?.bookingReportDocument.base64 ?? "", "base64");
  ok(pdf.subarray(0, 5).toString() === "%PDF-" && pdf.byteLength === doc.data.bookingReportDocument.byteLength, `[${tag}] bookingReportDocument: report-kit PDF (${(pdf.byteLength / 1024).toFixed(0)} KB, base64)`);
  const html = await gql(owner, 'query($b: ID!) { bookingReportDocument(bookingId: $b, format: html, variant: non_header) { html } }', { b: booking.booking.id });
  ok(/Asha Patel/.test(html.data?.bookingReportDocument.html ?? "") && /10\.2/.test(html.data.bookingReportDocument.html), `[${tag}] bookingReportDocument html (non-header) carries the patient and results`);

  // ---------------------------------------------------------------- billing + automatic posting (finance-kit → ledger-kit)
  const inv = await gql(owner, "mutation($i: IssueInvoiceInput!) { issueInvoice(input: $i) { id invoiceNo status totalPaise duePaise items { name ratePaise } } }", {
    i: { branchId: a.branch.id, patientId, bookingId: booking.booking.id, items: [{ code: "CBC" }, { code: "HOME", name: "Home collection", category: "service", ratePaise: 10000 }], payments: [{ amountPaise: 20000, mode: "cash" }] },
  });
  const invoiceId = inv.data?.issueInvoice.id;
  ok(inv.data?.issueInvoice.status === "partially_paid" && inv.data.issueInvoice.totalPaise === 49900, `[${tag}] issueInvoice ${inv.data?.issueInvoice.invoiceNo}: CBC price from the catalog, Rs 499, partially paid`);
  ok(code(await gql(owner, "mutation($id: ID!) { recordPayment(invoiceId: $id, payment: { amountPaise: 999999, mode: upi }) { id } }", { id: invoiceId })) === "CONFLICT", `[${tag}] overpayment → CONFLICT`);
  const paid = await gql(owner, 'mutation($id: ID!) { recordPayment(invoiceId: $id, payment: { amountPaise: 29900, mode: upi, reference: "UPI9" }) { status payments { mode } vouchers { type entries { ledger { name } debitPaise creditPaise } } } }', { id: invoiceId });
  ok(paid.data?.recordPayment.status === "paid" && paid.data.recordPayment.vouchers.length === 3, `[${tag}] recordPayment → paid; sales + 2 receipt vouchers posted through finance-kit`);
  const tb = await gql(owner, "{ trialBalance { differencePaise totalDebitPaise } outstandingReceivables { totalDuePaise } }");
  ok(tb.data?.trialBalance.differencePaise === 0 && tb.data.trialBalance.totalDebitPaise > 0 && tb.data.outstandingReceivables.totalDuePaise === 0, `[${tag}] trial balance balances (ledger-kit); nothing outstanding`);
  const invDoc = await gql(owner, "query($id: ID!) { invoiceDocument(invoiceId: $id) { base64 fileName } h: invoiceDocument(invoiceId: $id, format: html) { html } }", { id: invoiceId });
  ok(Buffer.from(invDoc.data?.invoiceDocument.base64 ?? "", "base64").subarray(0, 5).toString() === "%PDF-" && invDoc.data.h.html.includes(inv.data.issueInvoice.invoiceNo), `[${tag}] invoiceDocument: invoice-kit PDF + HTML of the stored invoice (totals match)`);
  // ---------------------------------------------------------------- tube labels, calculated values, methods, refunds on paper
  {
    const lft = (await gql(owner, "mutation($i: CreateBookingInput!) { createBooking(input: $i) { booking { id } samples { id barcode } } }", { i: { branchId: a.branch.id, patientId, tests: [{ testCode: "LIFT" }] } })).data?.createBooking;
    const sid = lft.samples[0].id;
    ok((await gql(owner, 'mutation($id: ID!) { relabelSample(id: $id, barcode: "TUBE-0001") { barcode } }', { id: sid })).data?.relabelSample.barcode === "TUBE-0001", `[${tag}] relabelSample: the tube's own label replaces the generated barcode`);
    ok(code(await gql(owner, 'mutation($id: ID!) { relabelSample(id: $id, barcode: "x") { barcode } }', { id: sid })) === "BAD_USER_INPUT", `[${tag}] a malformed barcode → BAD_USER_INPUT`);
    const taken = await gql(owner, 'mutation($id: ID!) { collectSample(id: $id, barcode: "TUBE-0001") { barcode } }', { id: booking.samples[0].id });
    ok(code(taken) === "CONFLICT", `[${tag}] a received sample keeps its barcode → CONFLICT`);
    const lft2 = (await gql(owner, "mutation($i: CreateBookingInput!) { createBooking(input: $i) { samples { id } } }", { i: { branchId: a.branch.id, patientId, tests: [{ testCode: "LIFT" }] } })).data?.createBooking;
    const dup = await gql(owner, 'mutation($id: ID!) { collectSample(id: $id, barcode: "TUBE-0001") { barcode } }', { id: lft2.samples[0].id });
    ok(code(dup) === "BARCODE_TAKEN" && (dup.errors?.[0]?.extensions as { barcode?: string } | undefined)?.barcode === "TUBE-0001", `[${tag}] the same label on a second tube → BARCODE_TAKEN`);
    const col = await gql(owner, 'mutation($id: ID!) { collectSample(id: $id, barcode: "TUBE-0002") { status barcode } }', { id: lft2.samples[0].id });
    ok(col.data?.collectSample.status === "collected" && col.data.collectSample.barcode === "TUBE-0002", `[${tag}] collectSample with the tube's label`);
    await gql(owner, "mutation($id: ID!) { collectSample(id: $id) { id } }", { id: sid });
    await gql(owner, "mutation($id: ID!) { receiveSample(id: $id) { id } }", { id: sid });
    const lr = (await gql(owner, 'mutation($b: ID!) { createReport(bookingId: $b, testCode: "LIFT") { id } }', { b: lft.booking.id })).data?.createReport.id;
    const lsaved = await gql(owner, "mutation($r: ID!, $x: [ResultInput!]!) { saveResults(reportId: $r, results: $x) { results { parameter value flag } } }", {
      r: lr, x: [{ parameter: "BILIRUBIN - TOTAL", value: "2.60" }, { parameter: "BILIRUBIN -DIRECT", value: "1.10" }, { parameter: "TOTAL-PROTEIN", value: "7.60" }, { parameter: "ALBUMIN - SERUM", value: "4.40" }],
    });
    const byName = new Map<string, { value: string; flag: string }>((lsaved.data?.saveResults.results ?? []).map((x: any) => [x.parameter, x]));
    ok(byName.get("BILIRUBIN (INDIRECT)")?.value === "1.5" && byName.get("GLOBULIN")?.value === "3.2" && byName.get("ALB/GLOBULIN RATIO")?.value === "1.38", `[${tag}] saveResults computes calculated parameters (indirect bilirubin, globulin, A/G ratio)`);
    ok(byName.get("BILIRUBIN (INDIRECT)")?.flag === "H", `[${tag}] …and flags them (indirect bilirubin 1.5 → H)`);
    await gql(owner, "mutation($r: ID!) { verifyReport(id: $r) { id } }", { r: lr });
    const lhtml = (await gql(owner, "query($b: ID!) { bookingReportDocument(bookingId: $b, format: html) { html } }", { b: lft.booking.id })).data?.bookingReportDocument.html ?? "";
    ok(/DIAZO/i.test(lhtml) && /GLOBULIN/.test(lhtml), `[${tag}] the printed report carries each parameter's method and the calculated rows`);
    ok(/TUBE-0001/.test(lhtml), `[${tag}] the report's Sample ID is the tube barcode, not the booking number`);
    // every catalog test can be saved: unnamed narrative blocks once crashed saveResults ("reading 'trim'")
    const broken = TESTS.filter((t) => { try { withCatalogDefaults(t.code ?? "", t.parameters.filter((x) => x.name).map((x) => ({ parameter: x.name!, value: "1" })), "male", 30); return false; } catch { return true; } });
    ok(broken.length === 0, `[${tag}] results for all ${TESTS.length} catalog tests save without errors${broken.length ? ` (failed: ${broken.slice(0, 5).map((t) => t.code).join(", ")})` : ""}`);
    // names, Widal titres → RESULT, narratives print as notes and are never stored as results
    const jp = await gql(owner, "mutation($i: RegisterPatientInput!) { registerPatient(input: $i) { id name } }", { i: { branchId: a.branch.id, name: "  jyoti   koshariya ", sex: "female", ageYears: 20 } });
    ok(jp.data?.registerPatient.name === "Jyoti Koshariya", `[${tag}] names are saved with capitals ("${jp.data?.registerPatient.name}")`);
    const wb = (await gql(owner, "mutation($i: CreateBookingInput!) { createBooking(input: $i) { booking { id } samples { id } } }", { i: { branchId: a.branch.id, patientId: jp.data.registerPatient.id, tests: [{ testCode: "WIDS" }] } })).data?.createBooking;
    await gql(owner, "mutation($id: ID!) { collectSample(id: $id) { id } }", { id: wb.samples[0].id });
    await gql(owner, "mutation($id: ID!) { receiveSample(id: $id) { id } }", { id: wb.samples[0].id });
    const wr = (await gql(owner, 'mutation($b: ID!) { createReport(bookingId: $b, testCode: "WIDS") { id } }', { b: wb.booking.id })).data?.createReport.id;
    const ws = await gql(owner, "mutation($r: ID!, $x: [ResultInput!]!) { saveResults(reportId: $r, results: $x) { results { parameter value range } } }", {
      r: wr, x: [{ parameter: "S.Typhi Antigen (O)", value: "1:160" }, { parameter: "S.Typhi Antigen (H)", value: "1:40" }, { parameter: "Interpretation", value: "typed by mistake" }],
    });
    const wres = ws.data?.saveResults.results ?? [];
    ok(wres.find((x: any) => x.parameter === "RESULT")?.value === "POSITIVE", `[${tag}] Widal: RESULT computed from the titres (O 1:160 → POSITIVE)`);
    ok(!wres.some((x: any) => x.parameter === "Interpretation") && !wres.some((x: any) => / \/ /.test(x.range ?? "")), `[${tag}] a narrative is not stored as a result, and no options list prints as a range`);
    await gql(owner, "mutation($r: ID!) { verifyReport(id: $r) { id } }", { r: wr });
    const whtml = (await gql(owner, "query($b: ID!) { bookingReportDocument(bookingId: $b, format: html) { html } }", { b: wb.booking.id })).data?.bookingReportDocument.html ?? "";
    ok(/Sera from normal individuals/.test(whtml) && /Jyoti Koshariya/.test(whtml), `[${tag}] the lab's interpretation prints as a note under the test`);
    const li = (await gql(owner, "mutation($i: IssueInvoiceInput!) { issueInvoice(input: $i) { id } }", { i: { branchId: a.branch.id, patientId, bookingId: lft.booking.id, items: [{ code: "LIFT" }], payments: [] } })).data?.issueInvoice.id;
    const lt = (await gql(owner, "query($id: ID!) { invoice(id: $id) { totalPaise } }", { id: li })).data?.invoice.totalPaise;
    await gql(owner, "mutation($id: ID!, $p: PaymentInput!) { recordPayment(invoiceId: $id, payment: $p) { id } }", { id: li, p: { amountPaise: lt, mode: "cash" } });
    await gql(owner, "mutation($id: ID!, $p: PaymentInput!) { refundPayment(invoiceId: $id, payment: $p) { id } }", { id: li, p: { amountPaise: lt, mode: "cash" } });
    const rhtml = (await gql(owner, "query($id: ID!) { invoiceDocument(invoiceId: $id, format: html) { html } }", { id: li })).data?.invoiceDocument.html ?? "";
    ok(/REFUNDED/.test(rhtml) && !/>PAID</.test(rhtml) && /Refund/.test(rhtml) && /TUBE-0001/.test(rhtml), `[${tag}] a refunded invoice prints REFUNDED with the refund row (not PAID), and the booking's tube barcode`);
    const ci = (await gql(owner, "mutation($i: IssueInvoiceInput!) { issueInvoice(input: $i) { id } }", { i: { branchId: a.branch.id, patientId, items: [{ code: "LIFT" }] } })).data?.issueInvoice.id;
    await gql(owner, 'mutation($id: ID!) { cancelInvoice(id: $id, reason: "Duplicate bill") { id } }', { id: ci });
    const chtml = (await gql(owner, "query($id: ID!) { invoiceDocument(invoiceId: $id, format: html) { html } }", { id: ci })).data?.invoiceDocument.html ?? "";
    ok(/CANCELLED/.test(chtml) && !/Scan to pay/.test(chtml), `[${tag}] a cancelled invoice prints CANCELLED and asks for no payment`);
  }

  const anyDoc = await gql(owner, '{ renderReport(request: { sample: "cbc" }, format: html) { html } invoiceTotals(request: { invoice: { invoiceNo: "T-1", patient: { name: "Kavita Sharma", age: 32, sex: "Female" }, items: ["cbc"] } }) reportTemplates { templates { id } } }');
  ok(anyDoc.data?.renderReport.html.includes("<html") && anyDoc.data.invoiceTotals.total > 0 && anyDoc.data.reportTemplates.templates.length > 20, `[${tag}] renderReport / invoiceTotals / reportTemplates from request data`);
  ok(code(await gql(owner, "{ renderReport(request: { patient: { name: \"X\" } }) { fileName } }")) === "BAD_USER_INPUT", `[${tag}] bad report request → BAD_USER_INPUT`);

  const cash = (await db.rawRepos.ledgers.findBySystemKey(a.org.id, "cash"))!;
  const capital = (await db.rawRepos.ledgers.findBySystemKey(a.org.id, "capital"))!;
  ok(code(await gql(owner, "mutation($i: PostVoucherInput!) { postVoucher(input: $i) { id } }", { i: { branchId: a.branch.id, type: "journal", entries: [{ ledgerId: cash.id, debitPaise: 100 }, { ledgerId: capital.id, creditPaise: 50 }] } })) === "BAD_USER_INPUT", `[${tag}] unbalanced voucher → BAD_USER_INPUT`);
  const journal = await gql(owner, "mutation($i: PostVoucherInput!) { postVoucher(input: $i) { id voucherNo } }", { i: { branchId: a.branch.id, type: "journal", narration: "Capital", entries: [{ ledgerId: cash.id, debitPaise: 100000 }, { ledgerId: capital.id, creditPaise: 100000 }] } });
  ok(/^JRN\//.test(journal.data?.postVoucher.voucherNo ?? ""), `[${tag}] postVoucher (ledger-kit): ${journal.data?.postVoucher.voucherNo}`);
  ok(code(await gql(otherOwner, "mutation($i: PostVoucherInput!) { postVoucher(input: $i) { id } }", { i: { branchId: other.branch.id, type: "journal", entries: [{ ledgerId: cash.id, debitPaise: 100 }, { ledgerId: capital.id, creditPaise: 100 }] } })) === "NOT_FOUND", `[${tag}] cannot post into another organisation's ledgers`);
  ok(code(await gql(owner, "mutation($i: IssueInvoiceInput!) { issueInvoice(input: $i) { id } }", { i: { branchId: a.branch.id, patientId, items: [{ name: "X", qty: 0, ratePaise: 100 }] } })) === "BAD_USER_INPUT", `[${tag}] qty 0 → BAD_USER_INPUT`);

  // ---------------------------------------------------------------- permissions (front desk, branch A)
  ok(code(await gql(desk, "{ trialBalance { differencePaise } }")) === "FORBIDDEN", `[${tag}] front desk cannot read the books → FORBIDDEN`);
  const deskA = await gql(desk, "mutation($i: RegisterPatientInput!) { registerPatient(input: $i) { uhid } }", { i: { branchId: a.branch.id, name: "Walk In", sex: "male" } });
  const deskB = await gql(desk, "mutation($i: RegisterPatientInput!) { registerPatient(input: $i) { uhid } }", { i: { branchId: branchB.id, name: "Walk In", sex: "male" } });
  ok(deskA.data?.registerPatient.uhid && code(deskB) === "FORBIDDEN", `[${tag}] front desk registers in branch A, not branch B`);
  await gql(owner, "mutation($i: IssueInvoiceInput!) { issueInvoice(input: $i) { id } }", { i: { branchId: branchB.id, patientId, items: [{ code: "CBC" }] } });
  const deskList = await gql(desk, "{ invoices { branch { code } } }");
  ok(deskList.data?.invoices.length > 0 && deskList.data.invoices.every((i: any) => i.branch.code === "A01"), `[${tag}] lists only show the viewer's branches`);
  ok(code(await gql(desk, "mutation($i: IssueInvoiceInput!) { issueInvoice(input: $i) { id } }", { i: { branchId: a.branch.id, patientId, items: [{ code: "CBC" }], billDiscountPaise: 100 } })) === "FORBIDDEN", `[${tag}] discounts need invoice:discount`);
  ok((await gql(desk, "query($id: ID!) { invoice(id: $id) { vouchers { id } } }", { id: invoiceId })).data?.invoice.vouchers.length === 0, `[${tag}] nested vouchers hidden without accounts:read`);

  // ---------------------------------------------------------------- tenant isolation
  ok(code(await gql(otherOwner, "query($id: ID!) { invoice(id: $id) { id } }", { id: invoiceId })) === "NOT_FOUND", `[${tag}] another organisation cannot read this invoice`);
  ok((await gql(otherOwner, "query($id: ID!) { patient(id: $id) { id } }", { id: patientId })).data?.patient === null, `[${tag}] …or this patient`);
  ok(code(await gql(otherOwner, "query($id: ID!) { invoiceDocument(invoiceId: $id) { fileName } }", { id: invoiceId })) === "NOT_FOUND", `[${tag}] …or print it`);

  // ---------------------------------------------------------------- N+1
  for (let i = 0; i < 8; i++) await gql(owner, "mutation($i: IssueInvoiceInput!) { issueInvoice(input: $i) { id } }", { i: { branchId: a.branch.id, patientId, items: [{ name: "T", ratePaise: 1000 }] } });
  patientBatches = 0;
  const list = await gql(owner, "{ invoices(limit: 10) { invoiceNo patient { name } } }");
  ok(list.data?.invoices.length === 10 && patientBatches === 1, `[${tag}] 10 invoices → ${patientBatches} batched patient query (no N+1)`);

  // ---------------------------------------------------------------- finance-kit
  const rules = await gql(owner, "mutation { seedTaxRules { hsnSac ratePercent } }");
  ok(rules.data?.seedTaxRules.length > 0, `[${tag}] seedTaxRules (finance-kit defaults, verify with CA)`);
  const cust = await gql(owner, 'mutation { createCustomer(input: { code: "city-hosp", name: "City Hospital", kind: hospital, stateCode: "22", creditLimitPaise: 100000, creditDays: 30 }) { id code ledger { name } } }');
  const customerId = cust.data?.createCustomer.id;
  ok(cust.data?.createCustomer.code === "CITY-HOSP" && cust.data.createCustomer.ledger.name, `[${tag}] createCustomer with its receivable ledger`);
  const b2b = await gql(owner, "mutation($i: CustomerInvoiceInput!) { issueCustomerInvoice(input: $i) { id totalPaise customer { code } } }", { i: { branchId: a.branch.id, patientId, customerId, items: [{ code: "CBC" }] } });
  ok(b2b.data?.issueCustomerInvoice.customer.code === "CITY-HOSP", `[${tag}] issueCustomerInvoice (tax rules applied)`);
  ok(code(await gql(owner, "mutation($i: CustomerInvoiceInput!) { issueCustomerInvoice(input: $i) { id } }", { i: { branchId: a.branch.id, patientId, customerId, items: [{ name: "Big", ratePaise: 200000 }] } })) === "CREDIT_LIMIT_EXCEEDED", `[${tag}] over the credit limit → CREDIT_LIMIT_EXCEEDED`);
  const yearRange = { from: new Date(Date.now() - 86400_000 * 30), to: new Date(Date.now() + 86400_000) };
  const stmt = await gql(owner, "query($c: ID!, $f: DateTime!, $t: DateTime!) { customerStatement(customerId: $c, from: $f, to: $t) { closingPaise open { bucket } ageing { notDue } } }", { c: customerId, f: yearRange.from, t: yearRange.to });
  ok(stmt.data?.customerStatement.closingPaise === b2b.data.issueCustomerInvoice.totalPaise && stmt.data.customerStatement.open[0].bucket === "not_due", `[${tag}] customerStatement: closing = billed, not yet due`);
  const cn = await gql(owner, 'mutation($i: CreditNoteInput!) { issueCreditNote(input: $i) { creditNote { noteNo totalPaise } invoice { status creditedPaise } } }', { i: { invoiceId: b2b.data.issueCustomerInvoice.id, reason: "Test not done" } });
  ok(cn.data?.issueCreditNote.invoice.status === "credited", `[${tag}] issueCreditNote ${cn.data?.issueCreditNote.creditNote.noteNo} → invoice credited`);
  const returns = await gql(owner, "query($f: DateTime!, $t: DateTime!) { gstr3b(from: $f, to: $t) { outwardNilExemptPaise verifyWithCA } gstr1(from: $f, to: $t) { docs { nature total } } }", { f: yearRange.from, t: yearRange.to });
  ok(returns.data?.gstr3b.verifyWithCA.length > 0 && Array.isArray(returns.data.gstr1.docs), `[${tag}] gstr1 + gstr3b data, with the verify-with-CA list`);
  const csv = await gql(owner, "{ exportTrialBalance { fileName content } }");
  ok(/TOTAL/.test(csv.data?.exportTrialBalance.content ?? ""), `[${tag}] exportTrialBalance CSV ends with a TOTAL row`);
  await gql(owner, "mutation($i: PostVoucherInput!) { postVoucher(input: $i) { id } }", { i: { branchId: a.branch.id, type: "journal", narration: "=cmd|'/c calc'!A1", entries: [{ ledgerId: cash.id, debitPaise: 100 }, { ledgerId: capital.id, creditPaise: 100 }] } });
  const dayBookCsv = (await gql(owner, "query($f: DateTime!, $t: DateTime!) { exportDayBook(from: $f, to: $t) { content } }", { f: yearRange.from, t: yearRange.to })).data?.exportDayBook.content ?? "";
  ok(dayBookCsv.includes("'=cmd|'/c calc'!A1") && !/(^|,)=cmd/m.test(dayBookCsv), `[${tag}] exports defuse formula text (CSV injection, finance-kit 1.0.1)`);
  const partner = await gql(owner, 'mutation($b: ID!) { createPartner(input: { code: "cc1", name: "Collection Centre One", kind: collection_centre, branchId: $b, pan: "ABCDE1234F" }) { id branch { code } } }', { b: branchB.id });
  ok(partner.data?.createPartner.branch.code === "B01", `[${tag}] createPartner on branch B`);
  const agr = await gql(owner, 'mutation($p: ID!, $d: Day!) { addAgreement(input: { partnerId: $p, kind: revenue_share, shareBp: 2500, effectiveFrom: $d }) { id shareBp } }', { p: partner.data?.createPartner.id, d: "2026-04-01" });
  ok(agr.data?.addAgreement.shareBp === 2500, `[${tag}] addAgreement (25% revenue share)`);
  const period = istDay(new Date()).slice(0, 7);
  const prev = await gql(owner, "query($p: ID!, $m: String!) { settlementPreview(partnerId: $p, period: $m) { grossPaise sharePaise netPaise tds { tdsPaise } } }", { p: partner.data?.createPartner.id, m: period });
  ok(prev.data?.settlementPreview.sharePaise === Math.round(prev.data.settlementPreview.grossPaise / 4) && prev.data.settlementPreview.grossPaise > 0, `[${tag}] settlementPreview: share 25% of branch B's billing`);

  // ---------------------------------------------------------------- lock dates
  const today = istDay(new Date());
  await gql(owner, "mutation($d: Day!) { setLockDate(input: { upTo: $d, reason: \"test\" }) { lockedUpTo } }", { d: today });
  ok(code(await gql(owner, "mutation($i: PostVoucherInput!) { postVoucher(input: $i) { id } }", { i: { branchId: a.branch.id, type: "journal", entries: [{ ledgerId: cash.id, debitPaise: 100 }, { ledgerId: capital.id, creditPaise: 100 }] } })) === "PERIOD_LOCKED", `[${tag}] posting into a locked period → PERIOD_LOCKED`);
  await gql(owner, "mutation { setLockDate(input: { upTo: null }) { id } }");

  // ---------------------------------------------------------------- sessions and passwords
  ok((await gql(owner, "mutation { requestPasswordReset(email: \"desk@apl.test\") }")).data?.requestPasswordReset === true && mails.length === 1, `[${tag}] requestPasswordReset sends a link through the mailer`);
  ok((await gql(null, "mutation { requestPasswordReset(email: \"nobody@apl.test\") }")).data?.requestPasswordReset === true && mails.length === 1, `[${tag}] …and does not reveal unknown emails`);
  const resetToken = new URL(mails[0]!.link, "http://x").searchParams.get("token");
  ok((await gql(null, "mutation($t: String!) { resetPassword(token: $t, newPassword: \"Quiet-River-5821\") }", { t: resetToken })).data?.resetPassword === true, `[${tag}] resetPassword with the emailed token`);
  ok(code(await gql(desk, "{ organization { id } }")) === "UNAUTHENTICATED", `[${tag}] a password reset ends the old sessions`);
  const desk2 = await login("desk@apl.test", "Quiet-River-5821");
  ok(!!desk2, `[${tag}] login with the new password`);
  await gql(owner, "mutation($u: ID!) { disableUser(userId: $u) { status } }", { u: deskUser.data.createUser.id });
  ok(code(await gql(desk2, "{ organization { id } }")) === "UNAUTHENTICATED", `[${tag}] disableUser signs the user out at once`);
  const sessions = await gql(owner, "{ mySessions { current } }");
  ok(sessions.data?.mySessions.some((s: any) => s.current), `[${tag}] mySessions marks the current session`);
  await gql(owner, "mutation { logout }");
  ok(code(await gql(owner, "{ organization { id } }")) === "UNAUTHENTICATED", `[${tag}] logout ends the session`);

  // ---------------------------------------------------------------- access + refresh tokens (auth-kit JWT mode)
  const pair = (await gql(null, 'mutation { login(input: { email: "x@oth.test", password: "Lab-Owner-2026!" }) { accessToken accessExpiresAt refreshToken refreshExpiresAt token } }')).data?.login;
  ok(pair?.accessToken.split(".").length === 3 && pair.refreshToken.length > 20 && pair.token === pair.accessToken && new Date(pair.accessExpiresAt) < new Date(pair.refreshExpiresAt), `[${tag}] login → access JWT + refresh token (refresh outlives access)`);
  const next = (await gql(null, "mutation($r: String!) { refreshSession(refreshToken: $r) { accessToken refreshToken user { email } } }", { r: pair.refreshToken })).data?.refreshSession;
  ok(next?.user.email === "x@oth.test" && next.refreshToken !== pair.refreshToken && (await gql(next.accessToken, "{ organization { code } }")).data?.organization.code === "OTH", `[${tag}] refreshSession → new access token that works, next refresh token`);
  ok(code(await gql(null, "mutation($r: String!) { refreshSession(refreshToken: $r) { accessToken } }", { r: pair.refreshToken })) === "INVALID_TOKEN", `[${tag}] a spent refresh token → INVALID_TOKEN`);
  ok(code(await gql(null, 'mutation { refreshSession(refreshToken: "not-a-token") { accessToken } }')) === "INVALID_TOKEN", `[${tag}] an unknown refresh token → INVALID_TOKEN`);
  const [h, body] = next.accessToken.split(".");
  const forged = `${h}.${Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(body, "base64url").toString()), org: a.org.id })).toString("base64url")}.${next.accessToken.split(".")[2]}`;
  ok(code(await gql(forged, "{ organization { code } }")) === "UNAUTHENTICATED", `[${tag}] an access token with edited claims → UNAUTHENTICATED`);
  ok((await gql(null, "mutation($r: String!) { logout(refreshToken: $r) }", { r: next.refreshToken })).data?.logout === true && code(await gql(next.accessToken, "{ organization { id } }")) === "UNAUTHENTICATED", `[${tag}] logout(refreshToken) ends the session: its access token stops at once`);

  // device binding: the refresh token only works on the device that signed in
  const phone = { deviceId: "dev-phone-0001-abcdef", fingerprint: "fp-aaaaaaaaaaaa", clientSessionId: "tab-0001-xyz", info: { platform: "Android", timezone: "Asia/Kolkata" } };
  const bound = (await gql(null, 'mutation($d: DeviceInput) { login(input: { email: "x@oth.test", password: "Lab-Owner-2026!", device: $d }) { accessToken refreshToken } }', { d: phone })).data?.login;
  const devices = (await gql(bound.accessToken, "{ mySessions { current deviceId deviceInfo } }")).data?.mySessions.find((x: any) => x.current);
  ok(devices?.deviceId === phone.deviceId && devices.deviceInfo.platform === "Android", `[${tag}] login stores the device; mySessions shows it`);
  const same = (await gql(null, "mutation($r: String!, $d: DeviceInput) { refreshSession(refreshToken: $r, device: $d) { refreshToken } }", { r: bound.refreshToken, d: { ...phone, fingerprint: "fp-bbbbbbbbbbbb" } })).data?.refreshSession;
  ok(!!same?.refreshToken, `[${tag}] refresh on the same device (new fingerprint) works`);
  ok(code(await gql(null, "mutation($r: String!, $d: DeviceInput) { refreshSession(refreshToken: $r, device: $d) { refreshToken } }", { r: same.refreshToken, d: { deviceId: "dev-laptop-9999-zzzzzz" } })) === "INVALID_TOKEN" && code(await gql(bound.accessToken, "{ organization { id } }")) === "UNAUTHENTICATED", `[${tag}] refresh from another device → INVALID_TOKEN and the session ends`);

  // ---------------------------------------------------------------- one person in two labs: pick list and switching
  for (const [org, branch] of [[a.org.id, a.branch.id], [other.org.id, other.branch.id]] as const) {
    await db.rawRepos.users.create({ orgId: org, name: "Two Labs", email: "two@labs.test", passwordHash: await hashPassword(pw), status: "active", roles: [{ role: "front_desk", branchId: branch }] });
  }
  const pick = await gql(null, 'mutation { login(input: { email: "two@labs.test", password: "Lab-Owner-2026!" }) { accessToken } }');
  const choices = (pick.errors?.[0]?.extensions as { organizations?: { code: string; name: string }[] } | undefined)?.organizations;
  ok(code(pick) === "ORG_REQUIRED" && choices?.map((o) => `${o.code}:${o.name}`).join() === "APL:API Lab,OTH:Other Lab" && !JSON.stringify(pick).includes(a.org.id), `[${tag}] ORG_REQUIRED lists the labs to pick from (code + name, no ids)`);
  ok(!(await gql(null, 'mutation { login(input: { email: "two@labs.test", password: "wrong-password" }) { accessToken } }')).errors?.[0]?.extensions?.hasOwnProperty("organizations"), `[${tag}] a wrong password lists no labs`);
  const solo = await login("x@oth.test");
  const twoDev = { deviceId: "dev-two-labs-0001" };
  const inApl = (await gql(null, 'mutation($d: DeviceInput) { login(input: { email: "two@labs.test", password: "Lab-Owner-2026!", orgCode: "apl", device: $d }) { accessToken refreshToken } }', { d: twoDev })).data?.login;
  const mine = (await gql(inApl.accessToken, "{ myOrganizations { code name current } }")).data?.myOrganizations;
  ok(mine?.map((o: any) => `${o.code}:${o.current}`).join() === "APL:true,OTH:false", `[${tag}] myOrganizations: both labs, the current one marked`);
  ok((await gql(solo, "{ myOrganizations { code } }")).data?.myOrganizations.length === 1, `[${tag}] myOrganizations: one lab for a one-lab person`);
  const moved = (await gql(inApl.accessToken, 'mutation($d: DeviceInput) { switchOrganization(orgCode: "OTH", device: $d) { accessToken refreshToken user { email } } }', { d: twoDev })).data?.switchOrganization;
  ok((await gql(moved?.accessToken, "{ organization { code } }")).data?.organization.code === "OTH" && code(await gql(inApl.accessToken, "{ organization { code } }")) === "UNAUTHENTICATED", `[${tag}] switchOrganization: new tokens work in the other lab, the old session ends`);
  ok(code(await gql(moved.accessToken, 'mutation { switchOrganization(orgCode: "OTH") { accessToken } }')) === "ORG_UNAVAILABLE" && code(await gql(moved.accessToken, 'mutation { switchOrganization(orgCode: "NOPE") { accessToken } }')) === "ORG_UNAVAILABLE" && code(await gql(solo, 'mutation { switchOrganization(orgCode: "OTH") { accessToken } }')) === "ORG_UNAVAILABLE", `[${tag}] switch to the current lab, an unknown code or a lab without an account → ORG_UNAVAILABLE`);
  ok(code(await gql(null, 'mutation { switchOrganization(orgCode: "APL") { accessToken } }')) === "UNAUTHENTICATED", `[${tag}] switchOrganization needs a session`);
  ok(code(await gql(moved.accessToken, 'mutation { switchOrganization(orgCode: "APL", device: { deviceId: "dev-elsewhere-0009" }) { accessToken } }')) === "INVALID_TOKEN" && code(await gql(moved.accessToken, "{ organization { code } }")) === "UNAUTHENTICATED", `[${tag}] switch from another device → INVALID_TOKEN and the session ends`);

  // ---------------------------------------------------------------- browser sessions in httpOnly cookies (src/graphql/cookies.ts)
  const jar = new Map<string, string>();
  let lastSetCookie: string[] = [];
  const browser = async (query: string, variables?: Record<string, unknown>, o: { header?: boolean; origin?: string; cookies?: Map<string, string> } = {}) => {
    const cookie = [...(o.cookies ?? jar)].map(([k, v]) => `${k}=${v}`).join("; ");
    const res = await app.inject({
      method: "POST",
      url: "/graphql",
      headers: { "content-type": "application/json", host: "lab.test", ...(o.header === false ? {} : { "x-mgpl-auth": "cookie" }), ...(o.origin ? { origin: o.origin } : {}), ...(cookie ? { cookie } : {}) },
      payload: JSON.stringify({ query, variables }),
    });
    const set = res.headers["set-cookie"];
    lastSetCookie = set === undefined ? [] : Array.isArray(set) ? set : [set];
    if (!o.cookies) for (const c of lastSetCookie) {
      const [pair] = c.split(";");
      const [k, v] = [pair!.slice(0, pair!.indexOf("=")), pair!.slice(pair!.indexOf("=") + 1)];
      if (/Max-Age=0/.test(c)) jar.delete(k);
      else jar.set(k, v);
    }
    return res.json() as Gql;
  };
  const cDev = { deviceId: "dev-cookie-browser-01" };
  const cLogin = (await browser('mutation($d: DeviceInput) { login(input: { email: "two@labs.test", password: "Lab-Owner-2026!", orgCode: "APL", device: $d }) { accessToken refreshToken token accessExpiresAt refreshExpiresAt user { email } } }', { d: cDev })).data?.login;
  ok(cLogin?.user.email === "two@labs.test" && cLogin.accessToken === null && cLogin.refreshToken === null && cLogin.token === null && !!cLogin.accessExpiresAt && !!cLogin.refreshExpiresAt, `[${tag}] cookie login: no token in the body, expiry times only`);
  ok(lastSetCookie.length === 2 && lastSetCookie.every((c) => /^__Host-mgpl_(access|refresh)=[A-Za-z0-9._-]{20,}; Path=\/; Max-Age=\d+; HttpOnly; SameSite=Strict; Secure$/.test(c)), `[${tag}] cookie login sets __Host- access and refresh cookies: HttpOnly, Secure, SameSite=Strict, Path=/`);
  const ages = lastSetCookie.map((c) => Number(/Max-Age=(\d+)/.exec(c)?.[1]));
  ok(ages[0] === ages[1] && ages[0]! > 3600, `[${tag}] the access cookie lives as long as the refresh cookie (the JWT inside still expires in 15 minutes)`);
  ok((await browser("{ organization { code } }")).data?.organization.code === "APL", `[${tag}] the access cookie authenticates (x-mgpl-auth: cookie)`);
  ok(code(await browser("{ organization { code } }", undefined, { header: false })) === "UNAUTHENTICATED", `[${tag}] CSRF: cookies without the x-mgpl-auth header are ignored`);
  ok((await browser("{ organization { code } }", undefined, { origin: "https://lab.test" })).data?.organization.code === "APL", `[${tag}] cookies from this host's own origin work`);
  const cookieRefresh = jar.get("__Host-mgpl_refresh")!;
  const cRef = (await browser("mutation($d: DeviceInput) { refreshSession(device: $d) { accessToken refreshToken user { email } } }", { d: cDev })).data?.refreshSession;
  ok(cRef?.user.email === "two@labs.test" && cRef.accessToken === null && cRef.refreshToken === null && lastSetCookie.length === 2 && jar.get("__Host-mgpl_refresh") !== cookieRefresh, `[${tag}] cookie refresh (no argument): new cookies, still no token in the body`);
  ok(code(await browser("mutation { refreshSession { accessToken } }", undefined, { header: false })) === "INVALID_TOKEN", `[${tag}] CSRF: refresh without the header does not read the cookie`);
  ok(code(await browser("mutation { refreshSession { accessToken } }", undefined, { cookies: new Map([["__Host-mgpl_refresh", cookieRefresh]]) })) === "INVALID_TOKEN" && lastSetCookie.length === 0, `[${tag}] a spent refresh cookie → INVALID_TOKEN, and no Set-Cookie (a racing refresh's new cookies stay)`);
  ok((await browser("{ organization { code } }")).data?.organization.code === "APL", `[${tag}] the current cookies still work after a stale tab's refresh (grace window)`);
  const cSwitch = (await browser('mutation($d: DeviceInput) { switchOrganization(orgCode: "OTH", device: $d) { accessToken refreshToken user { email } } }', { d: cDev })).data?.switchOrganization;
  ok(cSwitch?.accessToken === null && cSwitch.refreshToken === null && lastSetCookie.length === 2 && (await browser("{ organization { code } }")).data?.organization.code === "OTH", `[${tag}] cookie lab switch: the new session comes as cookies and works in the other lab`);
  const beforeLogout = new Map(jar);
  ok((await browser("mutation { logout }")).data?.logout === true && lastSetCookie.length === 2 && lastSetCookie.every((c) => /Max-Age=0/.test(c)) && jar.size === 0, `[${tag}] cookie logout clears both cookies`);
  ok(code(await browser("{ organization { code } }", undefined, { cookies: beforeLogout })) === "UNAUTHENTICATED" && code(await browser("mutation { refreshSession { accessToken } }", undefined, { cookies: beforeLogout })) === "INVALID_TOKEN", `[${tag}] after logout the old cookies are dead on the server too`);
  ok((await browser("mutation { logout }")).data?.logout === true, `[${tag}] cookie logout without cookies is idempotent`);
  const mixed = (await browser('mutation { login(input: { email: "x@oth.test", password: "Lab-Owner-2026!" }) { accessToken } }', undefined, { header: false })).data?.login;
  ok(typeof mixed?.accessToken === "string" && lastSetCookie.length === 0, `[${tag}] without x-mgpl-auth, login returns bearer tokens and sets no cookie`);

  // ---------------------------------------------------------------- background documents (in-process queue here; BullMQ in [worker])
  const otherAgain = await login("x@oth.test");
  const owner2 = await login("owner@apl.test");
  const job = (await gql(owner2, "mutation($id: ID!) { startDocumentJob(input: { kind: invoice, invoiceId: $id }) { id state kind document { base64 } } }", { id: invoiceId })).data?.startDocumentJob;
  ok(job?.state === "completed" && Buffer.from(job.document.base64, "base64").subarray(0, 5).toString() === "%PDF-", `[${tag}] startDocumentJob (invoice) → completed with the PDF`);
  ok((await gql(owner2, "query($id: ID!) { job(id: $id) { state } }", { id: job.id })).data?.job.state === "completed" && (await gql(otherAgain, "query($id: ID!) { job(id: $id) { state } }", { id: job.id })).data?.job === null, `[${tag}] job(id): its owner reads it, nobody else`);
  ok(code(await gql(otherAgain, "mutation($id: ID!) { startDocumentJob(input: { kind: invoice, invoiceId: $id }) { id } }", { id: invoiceId })) === "NOT_FOUND", `[${tag}] startDocumentJob on another organisation's invoice → NOT_FOUND`);
  ok(code(await gql(owner2, "mutation { startDocumentJob(input: { kind: booking_reports }) { id } }")) === "BAD_USER_INPUT", `[${tag}] startDocumentJob without bookingId → BAD_USER_INPUT`);

  // ---------------------------------------------------------------- partner-lab imports (test/imports.ts)
  const raw = async (token: string, body: string) => {
    const res = await app.inject({ method: "POST", url: "/graphql", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, payload: body });
    return { status: res.statusCode, json: res.json() as Gql };
  };
  await importSuite({ tag, gql, ok, owner: owner2, otherOwner: otherAgain, login, branchA: a.branch.id, branchB: branchB.id, orgId: a.org.id, repos: container.db.repos, services: container.services, raw });

  // ---------------------------------------------------------------- server guards
  ok(code(await gql(null, "{ __schema { types { name } } }")) === "GRAPHQL_VALIDATION_FAILED", `[${tag}] introspection disabled when INTROSPECTION=0`);
  const deep = `{ invoices ${"{ booking { invoice ".repeat(7)}{ id }${" } }".repeat(7)} }`;
  ok(/levels deep/.test((await gql(otherOwner, deep)).errors?.[0]?.message ?? ""), `[${tag}] queries deeper than 12 levels are refused`);
  const aliases = (n: number, f: string) => `{ ${Array.from({ length: n }, (_, i) => `a${i}: ${f}`).join(" ")} }`;
  ok(/fields; the limit/.test((await gql(otherOwner, aliases(1000, "health { ok }"))).errors?.[0]?.message ?? ""), `[${tag}] 1,000 aliases are refused (field limit)`);
  ok(/top-level fields/.test((await gql(otherOwner, aliases(21, "trialBalance { differencePaise }"))).errors?.[0]?.message ?? ""), `[${tag}] more than 20 top-level fields are refused`);
  ok(/documents; the limit/.test((await gql(otherOwner, aliases(4, "letterhead { byteLength }"))).errors?.[0]?.message ?? ""), `[${tag}] more than 3 documents in one request are refused`);
  const typo = (await gql(null, "{ organizaton { id } }")).errors?.[0]?.message ?? "";
  ok(/organizaton/.test(typo) && !/Did you mean/.test(typo), `[${tag}] no "Did you mean" field suggestions when introspection is off`);

  await app.close();
}

/** The production path: the container builds its own database and auth from the environment. */
async function fromConfig(url: string) {
  console.log("\n[config]");
  const container = await createContainer({ config: loadConfig({ NODE_ENV: "test", DB_BACKEND: "pg", DATABASE_URL: url }) });
  const app = await buildServer(container);
  const post = async (payload: unknown, token?: string) =>
    (await app.inject({ method: "POST", url: "/graphql", headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, payload: JSON.stringify(payload) })).json() as Gql;
  const login = await post({ query: 'mutation { login(input: { email: "owner@apl.test", password: "Lab-Owner-2026!" }) { accessToken } }' });
  const org = await post({ query: "{ organization { code } }" }, login.data?.login.accessToken);
  ok(org.data?.organization.code === "APL", "[config] createContainer from env: own db-kit + auth-kit (memory sessions), login works");
  await clientSdk(app);
  await clientCookies(app);
  const pre = await app.inject({ method: "OPTIONS", url: "/graphql", headers: { origin: "http://localhost:3000", "access-control-request-method": "POST" } });
  ok(pre.statusCode < 300 && pre.headers["access-control-allow-origin"] !== undefined, "[config] CORS preflight answered");
  ok(pre.headers["access-control-allow-credentials"] === "true" && String(pre.headers["access-control-allow-headers"]).split(", ").includes("x-mgpl-auth"), "[config] CORS allows credentials and the x-mgpl-auth header");
  {
    const c = await createContainer({ config: loadConfig({ NODE_ENV: "test", DB_BACKEND: "pg", DATABASE_URL: url, CORS_ORIGINS: "https://lab.example.in" }) });
    const s = await buildServer(c);
    const allowed = await s.inject({ method: "OPTIONS", url: "/graphql", headers: { origin: "https://lab.example.in", "access-control-request-method": "POST", "access-control-request-headers": "content-type,x-mgpl-auth" } });
    const login = await s.inject({ method: "POST", url: "/graphql", headers: { "content-type": "application/json", host: "api.example.in", origin: "https://lab.example.in", "x-mgpl-auth": "cookie" }, payload: JSON.stringify({ query: 'mutation { login(input: { email: "owner@apl.test", password: "Lab-Owner-2026!" }) { accessToken } }' }) });
    const evil = await s.inject({ method: "POST", url: "/graphql", headers: { "content-type": "application/json", host: "api.example.in", origin: "https://evil.test", "x-mgpl-auth": "cookie" }, payload: JSON.stringify({ query: 'mutation { login(input: { email: "owner@apl.test", password: "Lab-Owner-2026!" }) { accessToken } }' }) });
    ok(allowed.headers["access-control-allow-origin"] === "https://lab.example.in" && allowed.headers["access-control-allow-credentials"] === "true", "[config] CORS_ORIGINS (VPS): the listed origin may send credentials");
    ok([login.headers["set-cookie"]].flat().length === 2 && (login.json() as Gql).data?.login.accessToken === null, "[config] a listed origin on another host gets cookie sessions");
    ok(evil.headers["set-cookie"] === undefined && typeof (evil.json() as Gql).data?.login.accessToken === "string" && evil.headers["access-control-allow-origin"] !== "https://evil.test", "[config] an unlisted origin gets no cookies (and no CORS header, so its page cannot read the answer)");
    const t = (login.json() as Gql, [login.headers["set-cookie"]].flat().map((c) => String(c).split(";")[0]).join("; "));
    const q = (origin: string) => s.inject({ method: "POST", url: "/graphql", headers: { "content-type": "application/json", host: "api.example.in", origin, "x-mgpl-auth": "cookie", cookie: t }, payload: JSON.stringify({ query: "{ organization { code } }" }) });
    ok(((await q("https://lab.example.in")).json() as Gql).data?.organization.code === "APL" && code((await q("https://evil.test")).json() as Gql) === "UNAUTHENTICATED", "[config] CSRF: the cookies work from the listed origin and are ignored from any other, header or not");
    await s.close();
  }
  {
    const throws = (env: Record<string, string>) => { try { loadConfig(env); return false; } catch { return true; } };
    const prod = { NODE_ENV: "production", DATABASE_URL: "x", CORS_ORIGINS: "https://a.test", JWT_SECRET: "x".repeat(32) };
    ok(throws({ ...prod, AUTH_COOKIE_SECURE: "false" }) && throws({ NODE_ENV: "test", AUTH_COOKIE_SECURE: "false", AUTH_COOKIE_SAMESITE: "none" }) && throws({ NODE_ENV: "test", AUTH_COOKIE_SAMESITE: "loose" }), "[config] cookies: Secure in production, SameSite=None needs Secure, SameSite is checked");
    const dev = loadConfig({ NODE_ENV: "test", AUTH_COOKIE_SECURE: "false", AUTH_COOKIE_SAMESITE: "lax" }).authCookies;
    ok(dev.secure === false && dev.sameSite === "Lax" && loadConfig(prod).authCookies.secure && loadConfig(prod).authCookies.sameSite === "Strict" && !loadConfig({ NODE_ENV: "test", AUTH_COOKIES: "false" }).authCookies.enabled, "[config] cookie defaults: on, Secure, SameSite=Strict");
  }
  const res = await app.inject({ method: "POST", url: "/graphql", headers: { "content-type": "application/json" }, payload: JSON.stringify({ query: "{ health { ok } }" }) });
  ok(res.headers["x-content-type-options"] === "nosniff" && res.headers["x-frame-options"] === "DENY" && res.headers["referrer-policy"] === "no-referrer", "[config] security-kit headers on GraphQL responses");
  ok((await app.inject({ url: "/health" })).headers["x-content-type-options"] === "nosniff", "[config] security-kit headers on /health");
  await app.close();

  // client IP: X-Forwarded-For counts only through TRUST_PROXY proxies, so a client cannot choose its IP
  const sessionIp = async (env: Record<string, string>) => {
    const c = await createContainer({ config: loadConfig({ NODE_ENV: "test", DB_BACKEND: "pg", DATABASE_URL: url, ...env }) });
    const s = await buildServer(c);
    const headers = { "content-type": "application/json", "x-forwarded-for": "6.6.6.6, 203.0.113.9" };
    const r = (await s.inject({ method: "POST", url: "/graphql", headers, payload: JSON.stringify({ query: 'mutation { login(input: { email: "owner@apl.test", password: "Lab-Owner-2026!" }) { accessToken } }' }) })).json() as Gql;
    const me = (await s.inject({ method: "POST", url: "/graphql", headers: { ...headers, authorization: `Bearer ${r.data?.login.accessToken}` }, payload: JSON.stringify({ query: "{ mySessions { current ip } }" }) })).json() as Gql;
    await s.close();
    return me.data?.mySessions.find((x: any) => x.current)?.ip as string | undefined;
  };
  ok((await sessionIp({ TRUST_PROXY: "1" })) === "203.0.113.9", "[config] TRUST_PROXY=1: the IP the load balancer saw, never the spoofed left entry");
  ok((await sessionIp({})) === "127.0.0.1", "[config] no TRUST_PROXY: X-Forwarded-For is ignored");

  // request ids: a UUIDv7 per request (never Fastify's "req-1" counter); X-Request-ID kept only from a trusted proxy
  {
    const UUID7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
    const ids = async (env: Record<string, string>) => {
      const c = await createContainer({ config: loadConfig({ NODE_ENV: "test", DB_BACKEND: "pg", DATABASE_URL: url, ...env }) });
      const s = await buildServer(c);
      const q = async (headers: Record<string, string> = {}) =>
        String((await s.inject({ method: "POST", url: "/graphql", headers: { "content-type": "application/json", ...headers }, payload: JSON.stringify({ query: "{ health { ok } }" }) })).headers["x-request-id"]);
      const out = { a: await q(), b: await q(), sent: await q({ "x-request-id": "0123456789abcdef0123456789abcdef" }), bad: await q({ "x-request-id": "evil\tid" }), health: String((await s.inject({ url: "/health?live=1" })).headers["x-request-id"]) };
      await s.close();
      return out;
    };
    const direct = await ids({}), proxied = await ids({ TRUST_PROXY: "1" });
    ok(UUID7.test(direct.a) && UUID7.test(direct.b) && direct.a !== direct.b && UUID7.test(direct.health), "[config] x-request-id: a new UUIDv7 per request, on GraphQL and /health");
    ok(UUID7.test(direct.sent) && proxied.sent === "0123456789abcdef0123456789abcdef" && UUID7.test(proxied.bad), "[config] x-request-id: the incoming one is kept only through TRUST_PROXY, and only when well-formed");
  }

  // TLS fingerprint: read from TLS_FINGERPRINT_HEADER only through trusted proxies, stored hashed, a change audited
  const JA4 = "t13d1516h2_8daaf6152771_e5627efa2ab1", JA4b = "t13d1517h2_8daaf6152771_b1ff8ab2d16f";
  {
    const c = await createContainer({ config: loadConfig({ NODE_ENV: "test", DB_BACKEND: "pg", DATABASE_URL: url, TRUST_PROXY: "1", TLS_FINGERPRINT_HEADER: "X-JA4" }) });
    const s = await buildServer(c);
    const call = async (query: string, ja4: string, token?: string) =>
      (await s.inject({ method: "POST", url: "/graphql", headers: { "content-type": "application/json", "x-ja4": ja4, ...(token ? { authorization: `Bearer ${token}` } : {}) }, payload: JSON.stringify({ query }) })).json() as Gql;
    const device = 'device: { deviceId: "dev-tls-test-0001" }';
    const l = await call(`mutation { login(input: { email: "owner@apl.test", password: "Lab-Owner-2026!", ${device} }) { accessToken refreshToken user { id } } }`, JA4);
    const sid = c.auth.verifyAccessToken(l.data?.login.accessToken)?.sid;
    const stored = () => c.auth.sessionsOf(l.data?.login.user.id).then((all) => all.find((x) => x.id === sid));
    ok((await stored())?.tlsFingerprintHash === hashTlsFingerprint(JA4) && !JSON.stringify(await stored()).includes(JA4), "[config] TLS_FINGERPRINT_HEADER: login stores the proxy's TLS fingerprint as a hash only");
    const r = await call(`mutation { refreshSession(refreshToken: "${l.data?.login.refreshToken}", ${device}) { accessToken } }`, JA4b);
    const audit = await call('{ auditLog(entity: "session") { action data } }', JA4b, r.data?.refreshSession.accessToken);
    const changed = audit.data?.auditLog.find((e: any) => e.action === "auth.tls_fingerprint_changed");
    ok(!!r.data?.refreshSession.accessToken && changed?.data?.to === hashTlsFingerprint(JA4b) && (await stored())?.tlsFingerprintHash === hashTlsFingerprint(JA4b), "[config] a refresh with another TLS fingerprint works and is audited (hashes)");
    await s.close();
  }
  {
    const c = await createContainer({ config: loadConfig({ NODE_ENV: "test", DB_BACKEND: "pg", DATABASE_URL: url }) });
    const s = await buildServer(c);
    const l = (await s.inject({ method: "POST", url: "/graphql", headers: { "content-type": "application/json", "x-ja4": JA4 }, payload: JSON.stringify({ query: 'mutation { login(input: { email: "owner@apl.test", password: "Lab-Owner-2026!" }) { accessToken user { id } } }' }) })).json() as Gql;
    const sid = c.auth.verifyAccessToken(l.data?.login.accessToken)?.sid;
    ok((await c.auth.sessionsOf(l.data?.login.user.id)).find((x) => x.id === sid)?.tlsFingerprintHash === undefined, "[config] without TLS_FINGERPRINT_HEADER a client's x-ja4 header is ignored");
    await s.close();
  }
  await updatesSuite(url);
  let refused = "";
  try { loadConfig({ NODE_ENV: "test", TLS_FINGERPRINT_HEADER: "x-ja4" }); } catch (e) { refused = (e as Error).message; }
  ok(/TRUST_PROXY/.test(refused), "[config] TLS_FINGERPRINT_HEADER without TRUST_PROXY is refused (the header would be spoofable)");
}

/** systemUpdates: versions from GitHub releases (stubbed), cache, changelog between versions, permissions, failures. */
async function updatesSuite(url: string) {
  const pw = "Lab-Owner-2026!";
  const release = (tag: string, extra: Record<string, unknown> = {}) => ({ tag_name: tag, name: `Release ${tag}`, body: `Changes in ${tag}`, html_url: `https://github.com/x/releases/${tag}`, published_at: "2026-11-01T10:00:00Z", draft: false, prerelease: false, ...extra });
  const feeds: Record<string, unknown> = {
    "mgpl-diagnostics/api": [release("v0.0.1"), release("v99.0.0"), release("v100.0.0-rc.1", { prerelease: true }), release("v101.0.0", { draft: true }), release("not-a-version"), release("v98.1.0", { html_url: "javascript:alert(1)" })],
    "mgpl-diagnostics/dashboard": [release("v0.2.0"), release("v0.3.0"), release("v0.1.0")],
  };
  let calls = 0;
  let status = 200;
  const stub: typeof fetch = async (input, init) => {
    calls++;
    const u = new URL(String(input));
    const repo = u.pathname.replace(/^\/repos\//, "").replace(/\/releases$/, "");
    ok(!(init?.headers as Record<string, string>)?.authorization, "[updates] no Authorization header to the feed without UPDATE_GITHUB_TOKEN");
    return new Response(status === 200 ? JSON.stringify(feeds[repo] ?? []) : "{}", { status, headers: { "content-type": "application/json" } });
  };
  const c = await createContainer({ config: loadConfig({ NODE_ENV: "test", DB_BACKEND: "pg", DATABASE_URL: url, UPDATE_CHECK: "1" }), fetch: stub });
  const s = await buildServer(c);
  const post = async (query: string, token?: string, variables?: Record<string, unknown>) =>
    (await s.inject({ method: "POST", url: "/graphql", headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, payload: JSON.stringify({ query, variables }) })).json() as Gql;
  const login = async (email: string, password: string) => (await post("mutation($i: LoginInput!) { login(input: $i) { accessToken } }", undefined, { i: { email, password } })).data?.login.accessToken as string;
  const owner = await login("owner@apl.test", pw);
  const Q = "query($v: String, $r: Boolean) { systemUpdates(dashboardVersion: $v, refresh: $r) { enabled error updateAvailable steps docsUrl checkedAt components { component current latest updateAvailable image changes { version notes url } } } }";
  const r = (await post(Q, owner, { v: "0.1.0" })).data?.systemUpdates;
  const api = r?.components.find((x: any) => x.component === "api");
  const dash = r?.components.find((x: any) => x.component === "dashboard");
  const { VERSION } = await import("../src/version");
  ok(r?.enabled && r.updateAvailable && !r.error && api?.current === VERSION && api.latest === "99.0.0" && api.image === "ghcr.io/mgpl-diagnostics/api", `[updates] api ${VERSION} → 99.0.0 (pre-releases, drafts and non-semver tags ignored)`);
  ok(api?.changes.map((x: any) => x.version).join() === "99.0.0,98.1.0" && api.changes[1].url === null, "[updates] changelog lists only the releases in between, newest first; a non-https link is dropped");
  ok(dash?.current === "0.1.0" && dash.latest === "0.3.0" && dash.updateAvailable && dash.changes.map((x: any) => x.version).join() === "0.3.0,0.2.0" && dash.changes[0].notes === "Changes in v0.3.0", "[updates] dashboard 0.1.0 → 0.3.0 with both changelogs");
  ok(r?.steps.some((x: string) => x.includes("MGPL_API_VERSION=99.0.0") && x.includes("MGPL_DASHBOARD_VERSION=0.3.0")) && r.steps.includes("docker compose pull"), "[updates] update steps name the target versions");
  const before = calls;
  await post(Q, owner, { v: "0.3.0" });
  await post(Q, owner, { v: "0.3.0", r: true });
  ok(calls === before, "[updates] cached: no second call to the feed within the interval, and refresh waits a minute");
  const odd = (await post(Q, owner, { v: "<script>" })).data?.systemUpdates.components.find((x: any) => x.component === "dashboard");
  ok(odd?.current === null && odd.updateAvailable === false && odd.changes.length === 1, "[updates] an unknown dashboard version is ignored (no notice, newest release shown)");
  ok(code(await post(Q)) === "UNAUTHENTICATED", "[updates] signed out → UNAUTHENTICATED");
  const branchId = (await post("{ branches { id } }", owner)).data?.branches[0].id;
  await post("mutation($i: CreateUserInput!) { createUser(input: $i) { id } }", owner, { i: { name: "Desk Upd", email: "desk-updates@apl.test", password: "Counter-Shift-7391", roles: [{ role: "front_desk", branchId }] } });
  ok(code(await post(Q, await login("desk-updates@apl.test", "Counter-Shift-7391"))) === "FORBIDDEN", "[updates] front desk → FORBIDDEN (settings:manage: owner and admin)");
  await s.close();

  status = 403;
  const c2 = await createContainer({ config: loadConfig({ NODE_ENV: "test", DB_BACKEND: "pg", DATABASE_URL: url, UPDATE_CHECK: "1" }), fetch: stub });
  const s2 = await buildServer(c2);
  const t2 = (await s2.inject({ method: "POST", url: "/graphql", headers: { "content-type": "application/json" }, payload: JSON.stringify({ query: 'mutation { login(input: { email: "owner@apl.test", password: "Lab-Owner-2026!" }) { accessToken } }' }) })).json() as Gql;
  const failed = ((await s2.inject({ method: "POST", url: "/graphql", headers: { "content-type": "application/json", authorization: `Bearer ${t2.data?.login.accessToken}` }, payload: JSON.stringify({ query: Q }) })).json() as Gql).data?.systemUpdates;
  ok(/rate limit/.test(failed?.error ?? "") && failed.updateAvailable === false && failed.components[0].current === VERSION, "[updates] feed refuses (403) → error says so, current versions still shown");
  await s2.close();

  const off = await new SystemService(loadConfig({ NODE_ENV: "production", DATABASE_URL: "x", CORS_ORIGINS: "https://a.test", JWT_SECRET: "x".repeat(32), UPDATE_CHECK: "false" }).updates, async () => { throw new Error("no call expected"); }).updates({});
  ok(off.enabled === false && off.error === null && off.components[0]?.latest === null, "[updates] UPDATE_CHECK=false: no outbound call");
  ok(loadConfig({ NODE_ENV: "production", DATABASE_URL: "x", CORS_ORIGINS: "https://a.test", JWT_SECRET: "x".repeat(32) }).updates.enabled, "[updates] on by default in production");
  let bad = false;
  try { loadConfig({ NODE_ENV: "test", UPDATE_REPO_API: "../../etc" }); } catch { bad = true; }
  ok(bad, "[updates] UPDATE_REPO_API must be owner/name");
}

/** @mgpl-diagnostics/client's session manager against this server: device signals, auto refresh, single flight, logout. */
async function clientSdk(app: Awaited<ReturnType<typeof buildServer>>) {
  let refreshes = 0;
  const fetchViaInject: typeof fetch = async (_url, init) => {
    const body = String(init?.body ?? "");
    if (body.includes("refreshSession")) refreshes++;
    const res = await app.inject({ method: "POST", url: "/graphql", headers: Object.fromEntries(new Headers(init?.headers).entries()), payload: body });
    return new Response(res.body, { status: res.statusCode, headers: { "content-type": String(res.headers["content-type"] ?? "application/json") } });
  };
  const client = createMgplGraphQLClient({ url: "http://api.test/graphql", fetch: fetchViaInject });
  const signedOut: string[] = [];
  client.session.subscribe((s) => s.status === "signed_out" && signedOut.push(s.status));
  await client.auth.login({ email: "owner@apl.test", password: "Lab-Owner-2026!" });
  const sessions = await client.auth.sessions();
  const mine = sessions.find((s) => s.current);
  ok(client.session.getSnapshot().status === "signed_in" && !!mine?.deviceId && typeof mine.deviceInfo === "object", "[client] login through the SDK sends device signals; the session records them");
  // pretend the access token is about to expire: the next calls refresh once, in parallel
  const cur = client.session.current()!;
  client.session.signIn({ ...cur, accessExpiresAt: new Date(Date.now() - 1000).toISOString() });
  const orgs = await Promise.all([1, 2, 3, 4, 5].map(() => client.organization.get()));
  ok(orgs.every((o) => o.code === "APL") && refreshes === 1 && client.session.current()!.refreshToken !== cur.refreshToken, `[client] 5 parallel calls with an expiring token → ${refreshes} refresh (single flight), new tokens`);
  // a bad access token: UNAUTHENTICATED → one refresh → retry
  client.session.signIn({ ...client.session.current()!, accessToken: "x.y.z" });
  ok((await client.organization.get()).code === "APL" && refreshes === 2, "[client] UNAUTHENTICATED → refresh and retry, transparently");
  const res = await client.session.fetch("http://api.test/graphql", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ query: "{ organization { code } }" }) });
  ok(((await res.json()) as Gql).data?.organization.code === "APL", "[client] session.fetch adds the token (for Apollo, urql, graphql-request, …)");
  const refreshToken = client.session.current()!.refreshToken!;
  await client.auth.logout();
  ok(client.session.getSnapshot().status === "signed_out" && signedOut.length === 1 && code((await app.inject({ method: "POST", url: "/graphql", headers: { "content-type": "application/json" }, payload: JSON.stringify({ query: "mutation($r: String!) { refreshSession(refreshToken: $r) { accessToken } }", variables: { r: refreshToken } }) })).json() as Gql) === "INVALID_TOKEN", "[client] logout ends the server session and notifies subscribers");
}

/**
 * The SDK in cookie mode (client 1.7+), as the dashboard runs it: a browser-like cookie jar, no token in
 * JavaScript or in the storage, auto refresh, lab switch and logout. Skipped on an older client.
 */
async function clientCookies(app: Awaited<ReturnType<typeof buildServer>>) {
  if (!("cookies" in createSessionManager({ device: false }))) {
    console.log("  (skipped: the installed @mgpl-diagnostics/client has no cookie mode yet; needs 1.7.0)");
    return;
  }
  const jar = new Map<string, string>();
  let refreshes = 0;
  const browserFetch: typeof fetch = async (_url, init) => {
    const body = String(init?.body ?? "");
    if (body.includes("refreshSession")) refreshes++;
    const headers: Record<string, string> = { ...Object.fromEntries(new Headers(init?.headers).entries()), host: "api.test" };
    // like a browser: cookies travel only with credentials
    if (init?.credentials === "include" && jar.size) headers.cookie = [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
    const res = await app.inject({ method: "POST", url: "/graphql", headers, payload: body });
    for (const c of [res.headers["set-cookie"] ?? []].flat()) {
      const [pair] = String(c).split(";");
      const name = pair!.slice(0, pair!.indexOf("="));
      if (/Max-Age=0/.test(String(c))) jar.delete(name);
      else jar.set(name, pair!.slice(name.length + 1));
    }
    return new Response(res.body, { status: res.statusCode, headers: { "content-type": String(res.headers["content-type"] ?? "application/json") } });
  };
  const stored: unknown[] = [];
  const storage = { value: null as any, get() { return this.value; }, set(v: unknown) { this.value = v; stored.push(v); } };
  // a variable, not a literal: this file also typechecks against clients without the option
  const options = { url: "http://api.test/graphql", fetch: browserFetch, cookies: true, storage };
  const session = createSessionManager(options);
  const client = createMgplGraphQLClient({ url: "http://api.test/graphql", fetch: browserFetch, session });
  const r = await client.auth.login({ email: "owner@apl.test", password: "Lab-Owner-2026!" });
  ok(r.accessToken === null && r.refreshToken === null && jar.size === 2 && session.getSnapshot().status === "signed_in" && (await client.organization.get()).code === "APL", "[client cookies] login sets the cookies; requests authenticate with them");
  session.signIn({ ...session.current()!, accessExpiresAt: new Date(Date.now() - 1000).toISOString() });
  const before = jar.get("__Host-mgpl_refresh");
  const orgs = await Promise.all([1, 2, 3].map(() => client.organization.get()));
  ok(orgs.every((o) => o.code === "APL") && refreshes === 1 && jar.get("__Host-mgpl_refresh") !== before, `[client cookies] an expiring session refreshes once through the refresh cookie (${refreshes})`);
  jar.set("__Host-mgpl_access", "x.y.z");
  ok((await client.organization.get()).code === "APL" && refreshes === 2, "[client cookies] UNAUTHENTICATED → refresh by cookie and retry");
  const raw = await session.fetch("http://api.test/graphql", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ query: "{ organization { code } }" }) });
  ok(((await raw.json()) as Gql).data?.organization.code === "APL", "[client cookies] session.fetch sends the header and credentials (Apollo, urql, …)");
  ok(!JSON.stringify(stored).match(/"(accessToken|refreshToken)":"/) && stored.every((v) => v === null || (v as { cookie?: boolean }).cookie === true), "[client cookies] the storage never holds a token");
  await client.auth.logout();
  ok(jar.size === 0 && session.getSnapshot().status === "signed_out", "[client cookies] logout clears the cookies and the session");
}

/**
 * The worker: the API process queues jobs in Redis (BullMQ) and a worker runs them, as in production.
 * Uses REDIS_URL, or starts `redis-server` when it is installed; skipped (with a note) otherwise.
 */
async function workerSuite(pgUrl: string) {
  console.log("\n[worker]");
  let url = process.env.REDIS_URL;
  let server: ChildProcess | undefined;
  if (!url) {
    const port = 6391;
    try {
      server = spawn("redis-server", ["--port", String(port), "--save", "", "--appendonly", "no"], { stdio: "ignore" });
      await new Promise<void>((resolve, reject) => {
        server!.once("error", reject);
        setTimeout(resolve, 400);
      });
      url = `redis://127.0.0.1:${port}`;
    } catch {
      console.log("  (skipped: set REDIS_URL or install redis-server)");
      return;
    }
  }
  const mails: { to: string; link: string }[] = [];
  const mailer: Mailer = { passwordReset: async (to, link) => void mails.push({ to: to.email, link }) };
  // IMPORT_INLINE_MAX_BYTES=1: every partner PDF is read by the worker
  const config = loadConfig({ NODE_ENV: "test", DB_BACKEND: "pg", DATABASE_URL: pgUrl, REDIS_URL: url, QUEUE_PREFIX: `mgpl-test-${process.pid}`, IMPORT_INLINE_MAX_BYTES: "1" });
  const api = await createContainer({ config, mailer });
  const app = await buildServer(api);
  const worker = startWorkers(api.jobDeps, { redisUrl: url, prefix: config.jobs.prefix, keepResultsMs: config.jobs.keepResultsMs, concurrency: 2 });
  const post = async (query: string, variables?: Record<string, unknown>, token?: string) =>
    (await app.inject({ method: "POST", url: "/graphql", headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, payload: JSON.stringify({ query, variables }) })).json() as Gql;
  const until = async <T>(fn: () => Promise<T | undefined | null | false>, ms = 20_000): Promise<T | undefined> => {
    for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 100))) {
      const v = await fn();
      if (v) return v;
    }
    return undefined;
  };
  try {
    ok(api.jobs.mode === "bullmq", "[worker] REDIS_URL → jobs go to BullMQ");
    const owner = (await post('mutation { login(input: { email: "owner@apl.test", password: "Lab-Owner-2026!" }) { accessToken refreshToken } }')).data?.login;
    const refreshed = (await post("mutation($r: String!) { refreshSession(refreshToken: $r) { accessToken } }", { r: owner?.refreshToken })).data?.refreshSession;
    ok(!!refreshed?.accessToken, "[worker] login + refreshSession with refresh tokens in Redis");

    ok((await post('mutation { requestPasswordReset(email: "owner@apl.test") }')).data?.requestPasswordReset === true, "[worker] requestPasswordReset answers at once (queued)");
    ok(await until(async () => mails.length === 1), "[worker] the worker created the token and sent the reset link");
    const token = new URL(mails[0]?.link ?? "/", "http://x").searchParams.get("token") ?? "";
    const redis = new Redis(url);
    const keys = await redis.keys(`${config.jobs.prefix}:*`);
    const values = (await Promise.all(keys.map(async (k) => ((await redis.type(k)) === "hash" ? JSON.stringify(await redis.hgetall(k)) : (await redis.type(k)) === "string" ? await redis.get(k) : "")))).join("\n");
    ok(token.length > 20 && !values.includes(token), `[worker] the reset token never sits in the queue (${keys.length} keys checked)`);
    await redis.quit();

    const invoiceId = (await post("{ invoices(limit: 1) { id } }", {}, refreshed.accessToken)).data?.invoices[0]?.id;
    const started = (await post("mutation($id: ID!) { startDocumentJob(input: { kind: invoice, invoiceId: $id, format: html }) { id state } }", { id: invoiceId }, refreshed.accessToken)).data?.startDocumentJob;
    ok(started && ["waiting", "active", "delayed"].includes(started.state), `[worker] startDocumentJob → ${started?.state}`);
    const done = await until(async () => {
      const j = (await post("query($id: ID!) { job(id: $id) { state attempts document { html } } }", { id: started.id }, refreshed.accessToken)).data?.job;
      return j?.state === "completed" ? j : null;
    });
    ok(done?.document.html.includes("<html"), "[worker] the worker rendered the invoice; job(id) returns it");
    const failed = (await post('mutation { startDocumentJob(input: { kind: invoice, invoiceId: "00000000-0000-4000-8000-000000000000" }) { id } }', {}, refreshed.accessToken));
    ok(failed.errors?.[0]?.extensions?.code === "NOT_FOUND", "[worker] unknown invoice → NOT_FOUND before queueing");

    // partner-lab import through the worker: the job carries the stored file's id, never the PDF
    const branchId = (await post("{ externalReports(first: 1) { nodes { branchId } } }", {}, refreshed.accessToken)).data?.externalReports.nodes[0]?.branchId;
    const copy = await PDFDocument.load(await clinovaPdf());
    copy.setTitle("worker copy");
    const pdfBase64 = Buffer.from(await copy.save()).toString("base64");
    const imported = (await post("mutation($p: String!, $b: ID) { importExternalReport(pdfBase64: $p, branchId: $b) { id lab status tests { name } } }", { p: pdfBase64, b: branchId }, refreshed.accessToken)).data?.importExternalReport;
    ok(imported?.lab === "clinova" && imported.status === "extracted" && imported.tests.length === 2, "[worker] importExternalReport over IMPORT_INLINE_MAX_BYTES: read by the worker, the API waits for it");
    const blank = await PDFDocument.create();
    blank.addPage();
    const bad = await post("mutation($p: String!, $b: ID) { importExternalReport(pdfBase64: $p, branchId: $b) { id } }", { p: Buffer.from(await blank.save()).toString("base64"), b: branchId }, refreshed.accessToken);
    ok(bad.errors?.[0]?.extensions?.code === "UNSUPPORTED_REPORT", "[worker] an unsupported PDF read by the worker → UNSUPPORTED_REPORT");
    const r2 = new Redis(url);
    const jobKeys = await r2.keys(`${config.jobs.prefix}:imports:*`);
    const dump = (await Promise.all(jobKeys.map(async (k) => ((await r2.type(k)) === "hash" ? JSON.stringify(await r2.hgetall(k)) : "")))).join("\n");
    ok(jobKeys.length > 0 && !dump.includes(pdfBase64.slice(100, 160)) && !dump.includes(refreshed.accessToken), `[worker] import jobs hold ids, not the PDF or a token (${jobKeys.length} keys checked)`);
    await r2.quit();
  } finally {
    await worker.close();
    await app.close();
    server?.kill();
  }
}

/**
 * PgBouncer in transaction mode in front of PostgreSQL: the whole pg suite again through it, then two API
 * replicas sharing PgBouncer and Redis (docs/17-scaling.md). Needs `pgbouncer` (PGBOUNCER_BIN) and Redis
 * (REDIS_URL, or `redis-server`); skipped with a note otherwise. CI installs both.
 */
async function pgbouncerSuite(pgPort: number, database: string) {
  console.log("\n[pgbouncer]");
  const bin = process.env.PGBOUNCER_BIN || "pgbouncer";
  const dir = join(tmpdir(), `mgpl-api-pgbouncer-${process.pid}`);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true, mode: 0o755 });
  const port = 64331;
  const poolSize = 3;
  // the same settings as deploy/docker-compose.yml: transaction pooling, a small server pool
  writeFileSync(join(dir, "userlist.txt"), '"postgres" "postgres"\n', { mode: 0o644 });
  writeFileSync(
    join(dir, "pgbouncer.ini"),
    [
      "[databases]",
      `${database} = host=127.0.0.1 port=${pgPort} dbname=${database}`,
      "[pgbouncer]",
      "listen_addr = 127.0.0.1",
      `listen_port = ${port}`,
      "unix_socket_dir =",
      "auth_type = scram-sha-256",
      `auth_file = ${join(dir, "userlist.txt")}`,
      "pool_mode = transaction",
      `default_pool_size = ${poolSize}`,
      "max_client_conn = 200",
      "ignore_startup_parameters = extra_float_digits",
      "",
    ].join("\n"),
    { mode: 0o644 },
  );
  // pgbouncer refuses to run as root
  const args = [...(process.getuid?.() === 0 ? ["-u", "nobody"] : []), join(dir, "pgbouncer.ini")];
  let bouncer: ChildProcess;
  try {
    bouncer = spawn(bin, args, { stdio: ["ignore", "ignore", "pipe"] });
    await new Promise<void>((resolve, reject) => {
      bouncer.once("error", reject);
      bouncer.once("exit", (c) => reject(new Error(`pgbouncer exited with ${c}`)));
      setTimeout(resolve, 500);
    });
  } catch (e) {
    console.log(`  (skipped: ${(e as Error).message}; install pgbouncer or set PGBOUNCER_BIN)`);
    rmSync(dir, { recursive: true, force: true });
    return;
  }
  bouncer.removeAllListeners("exit");
  const url = `postgres://postgres:postgres@127.0.0.1:${port}/${database}`;
  let redisUrl = process.env.REDIS_URL;
  let redisServer: ChildProcess | undefined;
  try {
    // 1. every pg check again, through PgBouncer in transaction mode
    const db = await createDb({ backend: "pg", pg: { url }, posting: financePosting });
    try {
      await suite(db, "pgbouncer");
    } finally {
      await db.close();
    }

    // 2. two replicas behind one load balancer: shared PgBouncer, shared Redis, nothing in process memory
    console.log("\n[replicas]");
    if (!redisUrl) {
      try {
        redisServer = spawn("redis-server", ["--port", "6392", "--save", "", "--appendonly", "no"], { stdio: "ignore" });
        await new Promise<void>((resolve, reject) => {
          redisServer!.once("error", reject);
          setTimeout(resolve, 400);
        });
        redisUrl = "redis://127.0.0.1:6392";
      } catch {
        console.log("  (skipped: set REDIS_URL or install redis-server)");
        return;
      }
    }
    // what every replica shares: the database (through PgBouncer), Redis and JWT_SECRET
    const replica = async () => {
      const config = loadConfig({ NODE_ENV: "test", DB_BACKEND: "pg", DATABASE_URL: url, REDIS_URL: redisUrl, JWT_SECRET: "replicas-share-one-jwt-secret-0123456789", DB_POOL_MAX: "4", DB_SYNC: "false", TRUST_PROXY: "1", QUEUE_PREFIX: `mgpl-replicas-${process.pid}` });
      return buildServer(await createContainer({ config }));
    };
    const [a, b] = [await replica(), await replica()];
    const gql = async (app: typeof a, query: string, variables?: Record<string, unknown>, token?: string, ip = "203.0.113.20"): Promise<Gql> =>
      (await app.inject({ method: "POST", url: "/graphql", headers: { "content-type": "application/json", "x-forwarded-for": ip, ...(token ? { authorization: `Bearer ${token}` } : {}) }, payload: JSON.stringify({ query, variables }) })).json() as Gql;
    try {
      const health = await a.inject({ url: "/health" });
      ok(health.statusCode === 200 && health.json().database === "ok" && health.json().redis === "ok", "[replicas] GET /health checks the database (through PgBouncer) and Redis");

      const login = (await gql(a, 'mutation { login(input: { email: "owner@apl.test", password: "Lab-Owner-2026!", device: { deviceId: "dev-replica-0001" } }) { accessToken refreshToken } }')).data?.login;
      ok((await gql(b, "{ organization { code } }", {}, login?.accessToken)).data?.organization.code === "APL", "[replicas] a session started on replica A works on replica B (sessions in Redis)");
      const next = (await gql(b, 'mutation($r: String!) { refreshSession(refreshToken: $r, device: { deviceId: "dev-replica-0001" }) { accessToken refreshToken } }', { r: login?.refreshToken })).data?.refreshSession;
      ok(!!next?.accessToken && code(await gql(a, 'mutation($r: String!) { refreshSession(refreshToken: $r, device: { deviceId: "dev-replica-0001" }) { accessToken } }', { r: login?.refreshToken })) === "INVALID_TOKEN", "[replicas] refresh on B; the spent refresh token is refused on A (single use across replicas)");

      // many writes at once from both replicas: 2 × DB_POOL_MAX client connections over a 3-connection server pool
      const token = next.accessToken;
      const branchId = (await gql(a, "{ organization { branches { id code } } }", {}, token)).data?.organization.branches.find((x: any) => x.code === "A01")?.id;
      const patientId = (await gql(a, '{ patients(search: "Asha") { id } }', {}, token)).data?.patients[0]?.id;
      const issued = await Promise.all(
        Array.from({ length: 16 }, (_, i) =>
          gql(i % 2 ? a : b, "mutation($i: IssueInvoiceInput!) { issueInvoice(input: $i) { invoiceNo } }", { i: { branchId, patientId, items: [{ code: "CBC" }], payments: [{ amountPaise: 10000, mode: "cash" }] } }, token),
        ),
      );
      const numbers = issued.map((r) => r.data?.issueInvoice.invoiceNo);
      ok(numbers.every(Boolean) && new Set(numbers).size === 16, `[replicas] 16 concurrent invoices (with payments) on both replicas: all posted, all numbers unique${issued.find((r) => r.errors) ? ` (${JSON.stringify(issued.find((r) => r.errors)?.errors)})` : ""}`);
      const direct = new Sequelize(`postgres://postgres:postgres@127.0.0.1:${pgPort}/${database}`, { dialect: "postgres", logging: false });
      const [row] = await direct.query<{ n: string }>("SELECT count(*) AS n FROM pg_stat_activity WHERE datname = :database AND pid <> pg_backend_pid()", { replacements: { database }, type: QueryTypes.SELECT });
      const servers = Number(row?.n);
      await direct.close();
      ok(servers <= poolSize, `[replicas] PostgreSQL saw ${servers} connection(s) from PgBouncer for 2 replicas × DB_POOL_MAX=4 (pool ${poolSize})`);
      const tb = (await gql(b, "{ trialBalance { totalDebitPaise totalCreditPaise } }", {}, token)).data?.trialBalance;
      ok(!!tb && tb.totalDebitPaise === tb.totalCreditPaise, "[replicas] the books still balance after the concurrent burst");

      ok((await gql(b, "mutation { logout }", {}, token)).data?.logout === true && code(await gql(a, "{ organization { id } }", {}, token)) === "UNAUTHENTICATED", "[replicas] logout on B ends the session on A at once");

      // login limits are shared: 10 attempts per window in all, not 10 per replica
      let limitedAt = 0;
      for (let i = 1; i <= 12 && !limitedAt; i++) {
        const r = await gql(i % 2 ? a : b, 'mutation { login(input: { email: "nobody@replicas.test", password: "wrong-password" }) { token } }', {}, undefined, "198.51.100.7");
        if (code(r) === "RATE_LIMITED") limitedAt = i;
      }
      ok(limitedAt > 0 && limitedAt <= 11, `[replicas] the login rate limit is shared across replicas (limited at attempt ${limitedAt || "never"})`);

      // graceful shutdown: A drains (/health 503, still serving), then closes; B carries on
      const stopping = shutdown(a, { drainMs: 400, timeoutMs: 10_000 });
      const drainingHealth = await a.inject({ url: "/health" });
      const servedWhileDraining = (await gql(a, "{ health { ok } }")).data?.health.ok;
      ok(drainingHealth.statusCode === 503 && drainingHealth.json().draining === true && servedWhileDraining === true && (await a.inject({ url: "/health?live=1" })).statusCode === 200, "[replicas] on shutdown /health → 503 (draining) while requests are still served; ?live=1 stays 200");
      await stopping;
      ok((await b.inject({ url: "/health" })).statusCode === 200, "[replicas] replica A shut down cleanly; B is still ready");
    } finally {
      await a.close();
      await b.close();
    }
  } finally {
    redisServer?.kill();
    bouncer.kill();
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Static checks: the documented example operations stay valid against the schema. */
function staticChecks() {
  console.log("\n[static]");
  const schema = buildSchema();
  const dir = new URL("../docs/examples/", import.meta.url);
  for (const f of readdirSync(dir).filter((n) => n.endsWith(".graphql"))) {
    const errs = validate(schema, parse(readFileSync(new URL(f, dir), "utf8")));
    ok(errs.length === 0, `docs/examples/${f} is valid${errs.length ? `: ${errs.map((e) => e.message).join("; ")}` : ""}`);
  }
  // the client contract: every operation @mgpl-diagnostics/client sends is valid here, and every root field has one
  const invalid = Object.entries(OPERATIONS).flatMap(([name, op]) => validate(schema, parse(op.document)).map((e) => `${name}: ${e.message}`));
  ok(invalid.length === 0, `client: all ${Object.keys(OPERATIONS).length} GraphQL operations are valid${invalid.length ? `: ${invalid.join("; ")}` : ""}`);
  const covered = new Set(Object.values(OPERATIONS).map((op) => op.field));
  const roots = [...Object.keys(schema.getQueryType()!.getFields()), ...Object.keys(schema.getMutationType()!.getFields())];
  const missing = roots.filter((f) => !covered.has(f));
  ok(missing.length === 0, `client: every query and mutation has a client operation${missing.length ? ` (missing: ${missing.join(", ")})` : ""}`);
}

/** mail-kit as the Mailer: the reset mail is rendered from the mail design language and sent once. */
async function mailSuite() {
  console.log("\n[mail]");
  const transport = memoryTransport();
  const mailer = mailKitMailer(createMailer({ transport, from: "MGPL <no-reply@apl.test>", brand: brandFromLab(MGPL_LAB) }));
  const link = "https://lab.apl.test/reset-password?token=abc%2B1&x=<y>";
  await mailer.passwordReset({ email: "desk@apl.test", name: "Desk <b>User</b>" }, link, new Date("2026-10-14T16:30:00Z"));
  const m = transport.sent[0];
  ok(transport.sent.length === 1 && m?.subject === "Reset your password" && JSON.stringify(m.to).includes("desk@apl.test"), "[mail] mail-kit sends the password-reset mail to the user");
  ok(!!m && m.text.includes(link) && m.html.includes(link.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")), "[mail] the reset link is in the text and (escaped) in the HTML");
  ok(!!m && !m.html.includes("<b>User</b>") && m.html.includes("Desk &lt;b&gt;User&lt;/b&gt;"), "[mail] user data is escaped in the HTML");
  ok(!!m && m.text.includes("14 Oct 2026, 10:00 pm IST") && m.text.includes(MGPL_LAB.name), "[mail] expiry in IST and the lab's brand footer");
  const cfg = (env: Record<string, string>) => loadConfig({ NODE_ENV: "test", DATABASE_URL: "unused", ...env });
  ok(mailerFromConfig(cfg({}), MGPL_LAB) === undefined, "[mail] no SMTP_URL and no MAIL_WEBHOOK_URL → no Mailer");
  ok(typeof mailerFromConfig(cfg({ SMTP_URL: "smtp://localhost:2525" }), MGPL_LAB)?.passwordReset === "function", "[mail] SMTP_URL → the mail-kit Mailer");
  const threw = (env: Record<string, string>) => { try { loadConfig(env); return false; } catch { return true; } };
  ok(threw({ NODE_ENV: "production", DATABASE_URL: "x", CORS_ORIGINS: "https://a.test", JWT_SECRET: "x".repeat(32), SMTP_URL: "smtps://u:p@smtp.test" }), "[mail] production refuses SMTP_URL without MAIL_FROM");
  ok(threw({ NODE_ENV: "test", DATABASE_URL: "x", SMTP_URL: "http://smtp.test" }), "[mail] SMTP_URL must be smtp:// or smtps://");
}

async function main() {
  const t0 = Date.now();
  staticChecks();
  await mailSuite();
  const backends = (process.env.TEST_BACKENDS ?? "pg,mongo").split(",").map((s) => s.trim());

  if (backends.includes("pg")) {
    const { default: EmbeddedPostgres } = await import("embedded-postgres");
    // in the temp folder: as root, embedded-postgres runs initdb as the "postgres" user, who may not write here
    const dir = join(tmpdir(), `mgpl-api-pg-${process.pid}`);
    rmSync(dir, { recursive: true, force: true });
    const pg = new EmbeddedPostgres({ databaseDir: dir, user: "postgres", password: "postgres", port: 54331, persistent: false });
    await pg.initialise();
    await pg.start();
    await pg.createDatabase("mgpl_api_test");
    const url = "postgres://postgres:postgres@localhost:54331/mgpl_api_test";
    const db = await createDb({ backend: "pg", pg: { url }, posting: financePosting });
    try {
      await suite(db, "pg");
      await fromConfig(url);
      await workerSuite(url);
      await pg.createDatabase("mgpl_api_pgb");
      await pgbouncerSuite(54331, "mgpl_api_pgb");
    } finally {
      await db.close();
      await pg.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  }

  if (backends.includes("mongo")) {
    const { MongoMemoryReplSet } = await import("mongodb-memory-server");
    const rs = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: "wiredTiger" } });
    const db = await createDb({ backend: "mongo", mongo: { uri: rs.getUri("mgpl_api_test") }, posting: financePosting });
    try {
      await suite(db, "mongo");
    } finally {
      await db.close();
      await rs.stop();
    }
  }

  console.log(`\n${passed} passed, ${failed} failed in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
