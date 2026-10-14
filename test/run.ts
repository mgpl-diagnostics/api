// End-to-end tests: the real server (Fastify + Yoga) over HTTP inject, real auth-kit sessions, real
// databases started in-process: PostgreSQL always, MongoDB (replica set) unless TEST_BACKENDS=pg.
//   npm test                     both backends (first run downloads the database binaries)
//   TEST_BACKENDS=pg npm test    PostgreSQL only (when MongoDB binaries cannot be downloaded)
import { readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hashPassword, SYSTEM_ROLES } from "@mgpl-diagnostics/auth-kit";
import { createDb, seedOrganization, type Db, type Repositories } from "@mgpl-diagnostics/db-kit";
import { financePosting, istDay } from "@mgpl-diagnostics/finance-kit";
import { OPERATIONS } from "@mgpl-diagnostics/client";
import { parse, validate } from "graphql";
import { loadConfig } from "../src/config/env";
import { buildSchema } from "../src/graphql/schema";
import { createContainer } from "../src/container";
import { buildServer } from "../src/server";
import type { Mailer } from "../src/services/auth.service";

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
  const login = async (email: string, password = pw) => (await gql(null, "mutation($i: LoginInput!) { login(input: $i) { token user { email } } }", { i: { email, password } })).data?.login.token as string;
  const owner = await login("owner@apl.test");
  const otherOwner = await login("x@oth.test");
  ok(typeof owner === "string" && owner.length > 20, `[${tag}] login → bearer token`);
  const viewer = await gql(owner, '{ viewer { user { email } organization { code } can(permission: "accounts:post") branchesFor(permission: "invoice:read") } }');
  ok(viewer.data?.viewer.user.email === "owner@apl.test" && viewer.data.viewer.organization.code === "APL" && viewer.data.viewer.can && viewer.data.viewer.branchesFor === null, `[${tag}] viewer: user, organisation, permissions`);
  ok((await gql(null, "{ viewer { user { id } } }")).data?.viewer === null, `[${tag}] viewer is null without a token`);

  const chart = await gql(owner, "mutation { setupChartOfAccounts { name systemKey } }");
  ok(chart.data?.setupChartOfAccounts.length > 10, `[${tag}] setupChartOfAccounts (tally-kit chart + finance-kit ledgers): ${chart.data?.setupChartOfAccounts.length} ledgers`);
  await gql(otherOwner, "mutation { setupChartOfAccounts { id } }");
  const branchB = (await gql(owner, 'mutation { createBranch(input: { code: "b01", name: "Branch B", kind: collection_center, stateCode: "22" }) { id code } }')).data?.createBranch;
  ok(branchB?.code === "B01", `[${tag}] createBranch (code upper-cased)`);
  const deskUser = await gql(owner, "mutation($i: CreateUserInput!) { createUser(input: $i) { id roles { role branch { code } } } }", {
    i: { name: "Desk", email: "desk@apl.test", password: "Counter-Shift-7391", roles: [{ role: "front_desk", branchId: a.branch.id }] },
  });
  ok(deskUser.data?.createUser.roles[0].branch.code === "A01", `[${tag}] createUser with a branch role (auth-kit hashes the password)`);
  ok(code(await gql(owner, "mutation($i: CreateUserInput!) { createUser(input: $i) { id } }", { i: { name: "W", email: "w@apl.test", password: "password", roles: [{ role: "front_desk" }] } })) === "WEAK_PASSWORD", `[${tag}] weak password → WEAK_PASSWORD`);
  const desk = await login("desk@apl.test", "Counter-Shift-7391");

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

  // ---------------------------------------------------------------- billing + automatic posting (finance-kit → tally-kit)
  const inv = await gql(owner, "mutation($i: IssueInvoiceInput!) { issueInvoice(input: $i) { id invoiceNo status totalPaise duePaise items { name ratePaise } } }", {
    i: { branchId: a.branch.id, patientId, bookingId: booking.booking.id, items: [{ code: "CBC" }, { code: "HOME", name: "Home collection", category: "service", ratePaise: 10000 }], payments: [{ amountPaise: 20000, mode: "cash" }] },
  });
  const invoiceId = inv.data?.issueInvoice.id;
  ok(inv.data?.issueInvoice.status === "partially_paid" && inv.data.issueInvoice.totalPaise === 49900, `[${tag}] issueInvoice ${inv.data?.issueInvoice.invoiceNo}: CBC price from the catalog, Rs 499, partially paid`);
  ok(code(await gql(owner, "mutation($id: ID!) { recordPayment(invoiceId: $id, payment: { amountPaise: 999999, mode: upi }) { id } }", { id: invoiceId })) === "CONFLICT", `[${tag}] overpayment → CONFLICT`);
  const paid = await gql(owner, 'mutation($id: ID!) { recordPayment(invoiceId: $id, payment: { amountPaise: 29900, mode: upi, reference: "UPI9" }) { status payments { mode } vouchers { type entries { ledger { name } debitPaise creditPaise } } } }', { id: invoiceId });
  ok(paid.data?.recordPayment.status === "paid" && paid.data.recordPayment.vouchers.length === 3, `[${tag}] recordPayment → paid; sales + 2 receipt vouchers posted through finance-kit`);
  const tb = await gql(owner, "{ trialBalance { differencePaise totalDebitPaise } outstandingReceivables { totalDuePaise } }");
  ok(tb.data?.trialBalance.differencePaise === 0 && tb.data.trialBalance.totalDebitPaise > 0 && tb.data.outstandingReceivables.totalDuePaise === 0, `[${tag}] trial balance balances (tally-kit); nothing outstanding`);
  const invDoc = await gql(owner, "query($id: ID!) { invoiceDocument(invoiceId: $id) { base64 fileName } h: invoiceDocument(invoiceId: $id, format: html) { html } }", { id: invoiceId });
  ok(Buffer.from(invDoc.data?.invoiceDocument.base64 ?? "", "base64").subarray(0, 5).toString() === "%PDF-" && invDoc.data.h.html.includes(inv.data.issueInvoice.invoiceNo), `[${tag}] invoiceDocument: invoice-kit PDF + HTML of the stored invoice (totals match)`);
  const anyDoc = await gql(owner, '{ renderReport(request: { sample: "cbc" }, format: html) { html } invoiceTotals(request: { invoice: { invoiceNo: "T-1", patient: { name: "Kavita Sharma", age: 32, sex: "Female" }, items: ["cbc"] } }) reportTemplates { templates { id } } }');
  ok(anyDoc.data?.renderReport.html.includes("<html") && anyDoc.data.invoiceTotals.total > 0 && anyDoc.data.reportTemplates.templates.length > 20, `[${tag}] renderReport / invoiceTotals / reportTemplates from request data`);
  ok(code(await gql(owner, "{ renderReport(request: { patient: { name: \"X\" } }) { fileName } }")) === "BAD_USER_INPUT", `[${tag}] bad report request → BAD_USER_INPUT`);

  const cash = (await db.rawRepos.ledgers.findBySystemKey(a.org.id, "cash"))!;
  const capital = (await db.rawRepos.ledgers.findBySystemKey(a.org.id, "capital"))!;
  ok(code(await gql(owner, "mutation($i: PostVoucherInput!) { postVoucher(input: $i) { id } }", { i: { branchId: a.branch.id, type: "journal", entries: [{ ledgerId: cash.id, debitPaise: 100 }, { ledgerId: capital.id, creditPaise: 50 }] } })) === "BAD_USER_INPUT", `[${tag}] unbalanced voucher → BAD_USER_INPUT`);
  const journal = await gql(owner, "mutation($i: PostVoucherInput!) { postVoucher(input: $i) { id voucherNo } }", { i: { branchId: a.branch.id, type: "journal", narration: "Capital", entries: [{ ledgerId: cash.id, debitPaise: 100000 }, { ledgerId: capital.id, creditPaise: 100000 }] } });
  ok(/^JRN\//.test(journal.data?.postVoucher.voucherNo ?? ""), `[${tag}] postVoucher (tally-kit): ${journal.data?.postVoucher.voucherNo}`);
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

  // ---------------------------------------------------------------- server guards
  ok(code(await gql(null, "{ __schema { types { name } } }")) === "GRAPHQL_VALIDATION_FAILED", `[${tag}] introspection disabled when INTROSPECTION=0`);
  const deep = `{ invoices ${"{ booking { invoice ".repeat(7)}{ id }${" } }".repeat(7)} }`;
  ok(/levels deep/.test((await gql(otherOwner, deep)).errors?.[0]?.message ?? ""), `[${tag}] queries deeper than 12 levels are refused`);

  await app.close();
}

/** The production path: the container builds its own database and auth from the environment. */
async function fromConfig(url: string) {
  console.log("\n[config]");
  const container = await createContainer({ config: loadConfig({ NODE_ENV: "test", DB_BACKEND: "pg", DATABASE_URL: url }) });
  const app = await buildServer(container);
  const post = async (payload: unknown, token?: string) =>
    (await app.inject({ method: "POST", url: "/graphql", headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, payload: JSON.stringify(payload) })).json() as Gql;
  const login = await post({ query: 'mutation { login(input: { email: "owner@apl.test", password: "Lab-Owner-2026!" }) { token } }' });
  const org = await post({ query: "{ organization { code } }" }, login.data?.login.token);
  ok(org.data?.organization.code === "APL", "[config] createContainer from env: own db-kit + auth-kit (memory sessions), login works");
  const pre = await app.inject({ method: "OPTIONS", url: "/graphql", headers: { origin: "http://localhost:3000", "access-control-request-method": "POST" } });
  ok(pre.statusCode < 300 && pre.headers["access-control-allow-origin"] !== undefined, "[config] CORS preflight answered");
  await app.close();
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

async function main() {
  const t0 = Date.now();
  staticChecks();
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
