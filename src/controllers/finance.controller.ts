import type {
  BankLineStatus, BankStatement, CashClosing, CreditNote, Customer, Partner, PeriodLock, Settlement, SettlementDeduction, SettlementStatus,
} from "@mgpl-diagnostics/db-kit";
import type { AgeBucket, FinanceConfig } from "@mgpl-diagnostics/finance-kit";
import type { RequestContext as Ctx } from "../graphql/context";
import { withErrorCodes } from "../graphql/errors";
import { actorOf, authorize, branchScope, cap } from "../graphql/guards";
import type { CustomerInput, CustomerInvoiceInput } from "../services/receivables.service";
import type { AgreementInput, PartnerInput } from "../services/settlement.service";
import type { TaxRuleInput } from "../services/gst.service";

const OPEN_BUCKET: Record<AgeBucket, string> = { not_due: "not_due", "1-30": "D1_30", "31-60": "D31_60", "61-90": "D61_90", "90+": "D90_PLUS" };
const ageing = (a: Record<AgeBucket, number>) => ({ notDue: a.not_due, d1to30: a["1-30"], d31to60: a["31-60"], d61to90: a["61-90"], d90plus: a["90+"] });
const voucherById = (ctx: Ctx, id?: string | null) => (id ? ctx.repos.vouchers.get(id) : null);

type Range = { from: Date; to: Date; branchId?: string | null; bom?: boolean };
type Gst = { from: Date; to: Date; gstin?: string | null; bom?: boolean };

async function settlementFor(ctx: Ctx, id: string, permission: string) {
  const s = await ctx.services.settlements.settlement(actorOf(ctx), id);
  authorize(ctx, permission, s.branchId);
  return s;
}

/**
 * finance-kit. Permissions as in finance-kit's docs/api.md: accounts:read for returns, statements and
 * exports; accounts:post for invoices, credit notes, settlements, cash and bank; accounts:manage for
 * tax rules, customers, partners, lock dates and the year-end close.
 */
export const financeController = withErrorCodes({
  Query: {
    taxRules: (_: unknown, __: unknown, ctx: Ctx) => ctx.services.gst.taxRules(authorize(ctx, "accounts:read")),
    financeConfig: async (_: unknown, __: unknown, ctx: Ctx) => {
      const c: FinanceConfig = await ctx.services.gst.config(authorize(ctx, "accounts:read"));
      return { b2clThresholdPaise: c.gst.b2clThresholdPaise, tds: c.tds, bankToleranceDays: c.bank.toleranceDays, bankMaxFeeBp: c.bank.maxFeeBp, clearingLedgerKeys: c.bank.clearingLedgerKeys };
    },
    verifyWithCA: (_: unknown, __: unknown, ctx: Ctx) => (actorOf(ctx), ctx.services.gst.verifyWithCA()),
    gstr1: (_: unknown, a: Gst, ctx: Ctx) => ctx.services.gst.gstr1(authorize(ctx, "accounts:read"), a),
    gstr3b: (_: unknown, a: Gst, ctx: Ctx) => ctx.services.gst.gstr3b(authorize(ctx, "accounts:read"), a),

    customers: (_: unknown, a: { activeOnly?: boolean }, ctx: Ctx) => ctx.services.receivables.customers(authorize(ctx, "accounts:read"), a.activeOnly ?? true),
    customer: async (_: unknown, a: { id: string }, ctx: Ctx) => {
      const c = await ctx.loaders.customer.load(a.id);
      return c && c.orgId === authorize(ctx, "accounts:read").orgId ? c : null;
    },
    customerStatement: async (_: unknown, a: { customerId: string; from: Date; to: Date }, ctx: Ctx) => {
      const s = await ctx.services.receivables.statement(authorize(ctx, "accounts:read"), a);
      return { ...s, open: s.open.map((o) => ({ ...o, bucket: OPEN_BUCKET[o.bucket] })), ageing: ageing(s.ageing) };
    },
    receivablesSummary: async (_: unknown, a: { asOf: Date }, ctx: Ctx) => {
      const s = await ctx.services.receivables.summary(authorize(ctx, "accounts:read"), a.asOf);
      return { ...s, rows: s.rows.map((r) => ({ ...r, ageing: ageing(r.ageing) })) };
    },
    creditNote: async (_: unknown, a: { id: string }, ctx: Ctx) => {
      const n = await ctx.services.receivables.creditNote(actorOf(ctx), a.id);
      authorize(ctx, "accounts:read", n.branchId);
      return n;
    },
    creditNotes: (_: unknown, a: { invoiceId?: string | null; customerId?: string | null; limit?: number; offset?: number }, ctx: Ctx) =>
      ctx.services.receivables.creditNotes(authorize(ctx, "accounts:read"), { ...a, limit: cap(a.limit, 50), offset: a.offset ?? 0 }),

    partners: (_: unknown, a: { branchId?: string | null }, ctx: Ctx) => ctx.services.settlements.partners(actorOf(ctx), { branchIds: branchScope(ctx, "accounts:read", a.branchId) }),
    partner: async (_: unknown, a: { id: string }, ctx: Ctx) => {
      const p = await ctx.services.settlements.partner(actorOf(ctx), a.id);
      authorize(ctx, "accounts:read", p.branchId);
      return p;
    },
    settlementPreview: async (_: unknown, a: { partnerId: string; period: string; deductions?: SettlementDeduction[] | null }, ctx: Ctx) => {
      const p = await ctx.services.settlements.partner(actorOf(ctx), a.partnerId);
      return ctx.services.settlements.compute(authorize(ctx, "accounts:read", p.branchId), a);
    },
    settlements: (_: unknown, a: { partnerId?: string | null; status?: SettlementStatus | null; branchId?: string | null; limit?: number; offset?: number }, ctx: Ctx) =>
      ctx.services.settlements.settlements(actorOf(ctx), { ...a, branchIds: branchScope(ctx, "accounts:read", a.branchId), limit: cap(a.limit, 50), offset: a.offset ?? 0 }),
    settlement: (_: unknown, a: { id: string }, ctx: Ctx) => settlementFor(ctx, a.id, "accounts:read"),

    cashClosings: (_: unknown, a: { branchId: string; limit?: number; offset?: number }, ctx: Ctx) =>
      ctx.services.cashBank.cashClosings(authorize(ctx, "accounts:read", a.branchId), { branchId: a.branchId, limit: cap(a.limit, 31), offset: a.offset ?? 0 }),
    bankStatements: (_: unknown, a: { ledgerId?: string | null; limit?: number; offset?: number }, ctx: Ctx) =>
      ctx.services.cashBank.bankStatements(authorize(ctx, "accounts:read"), { ledgerId: a.ledgerId, limit: cap(a.limit, 50), offset: a.offset ?? 0 }),
    bankLines: (_: unknown, a: { ledgerId?: string | null; statementId?: string | null; status?: BankLineStatus | null; limit?: number; offset?: number }, ctx: Ctx) =>
      ctx.services.cashBank.bankLines(authorize(ctx, "accounts:read"), { ...a, limit: cap(a.limit, 100), offset: a.offset ?? 0 }),
    bankReconciliation: (_: unknown, a: { ledgerId: string; asOf: Date }, ctx: Ctx) => ctx.services.cashBank.reconciliation(authorize(ctx, "accounts:read"), a),

    lockDates: (_: unknown, __: unknown, ctx: Ctx) => ctx.services.periods.locks(authorize(ctx, "accounts:read")),

    exportDayBook: (_: unknown, a: Range, ctx: Ctx) => ctx.services.exports.dayBook(authorize(ctx, "accounts:read", a.branchId), { ...a, bom: !!a.bom }),
    exportLedger: async (_: unknown, a: Range & { ledgerId: string }, ctx: Ctx) => {
      const actor = authorize(ctx, "accounts:read", a.branchId);
      await ctx.services.books.ledger(actor, a.ledgerId);
      return ctx.services.exports.ledger(actor, { ...a, bom: !!a.bom });
    },
    exportTrialBalance: (_: unknown, a: { asOf?: Date | null; branchId?: string | null; bom?: boolean }, ctx: Ctx) =>
      ctx.services.exports.trialBalance(authorize(ctx, "accounts:read", a.branchId), { ...a, bom: !!a.bom }),
    exportProfitAndLoss: (_: unknown, a: Range, ctx: Ctx) => ctx.services.exports.profitAndLoss(authorize(ctx, "accounts:read", a.branchId), { ...a, bom: !!a.bom }),
    exportBalanceSheet: (_: unknown, a: { asOf: Date; branchId?: string | null; bom?: boolean }, ctx: Ctx) =>
      ctx.services.exports.balanceSheet(authorize(ctx, "accounts:read", a.branchId), { ...a, bom: !!a.bom }),
    exportSettlement: async (_: unknown, a: { settlementId: string; bom?: boolean }, ctx: Ctx) => {
      await settlementFor(ctx, a.settlementId, "accounts:read");
      return ctx.services.exports.settlement(actorOf(ctx), { settlementId: a.settlementId, bom: !!a.bom });
    },
    exportGstr1: (_: unknown, a: Gst, ctx: Ctx) => ctx.services.exports.gstr1(authorize(ctx, "accounts:read"), { ...a, bom: !!a.bom }),
    exportGstr3b: (_: unknown, a: Gst, ctx: Ctx) => ctx.services.exports.gstr3b(authorize(ctx, "accounts:read"), { ...a, bom: !!a.bom }),
  },

  Customer: {
    ledger: (c: Customer, _: unknown, ctx: Ctx) => ctx.loaders.ledger.load(c.ledgerId),
  },
  CreditNote: {
    invoice: (n: CreditNote, _: unknown, ctx: Ctx) => ctx.loaders.invoice.load(n.invoiceId),
    customer: (n: CreditNote, _: unknown, ctx: Ctx) => ctx.loaders.customer.load(n.customerId),
  },
  Partner: {
    branch: (p: Partner, _: unknown, ctx: Ctx) => ctx.loaders.branch.load(p.branchId),
    ledger: (p: Partner, _: unknown, ctx: Ctx) => ctx.loaders.ledger.load(p.ledgerId),
    agreements: (p: Partner, _: unknown, ctx: Ctx) => ctx.services.settlements.agreements(p.id),
  },
  Settlement: {
    partner: (s: Settlement, _: unknown, ctx: Ctx) => ctx.loaders.partner.load(s.partnerId),
    branch: (s: Settlement, _: unknown, ctx: Ctx) => ctx.loaders.branch.load(s.branchId),
    accrualVoucher: (s: Settlement, _: unknown, ctx: Ctx) => voucherById(ctx, s.accrualVoucherId),
    payoutVoucher: (s: Settlement, _: unknown, ctx: Ctx) => voucherById(ctx, s.payoutVoucherId),
  },
  CashClosing: {
    branch: (c: CashClosing, _: unknown, ctx: Ctx) => ctx.loaders.branch.load(c.branchId),
    voucher: (c: CashClosing, _: unknown, ctx: Ctx) => voucherById(ctx, c.voucherId),
  },
  BankStatement: {
    branch: (s: BankStatement, _: unknown, ctx: Ctx) => ctx.loaders.branch.load(s.branchId),
    ledger: (s: BankStatement, _: unknown, ctx: Ctx) => ctx.loaders.ledger.load(s.ledgerId),
  },
  PeriodLock: {
    branch: (l: PeriodLock, _: unknown, ctx: Ctx) => ctx.loaders.branch.load(l.branchId),
  },

  Mutation: {
    addTaxRule: (_: unknown, { input }: { input: TaxRuleInput }, ctx: Ctx) => ctx.services.gst.addTaxRule(authorize(ctx, "accounts:manage"), input),
    seedTaxRules: (_: unknown, __: unknown, ctx: Ctx) => ctx.services.gst.seedTaxRules(authorize(ctx, "accounts:manage")),

    createCustomer: (_: unknown, { input }: { input: CustomerInput }, ctx: Ctx) => ctx.services.receivables.createCustomer(authorize(ctx, "accounts:manage"), input),
    updateCustomer: (_: unknown, a: { id: string; input: Partial<CustomerInput> & { active?: boolean | null } }, ctx: Ctx) =>
      ctx.services.receivables.updateCustomer(authorize(ctx, "accounts:manage"), a.id, a.input),
    issueCustomerInvoice: (_: unknown, { input }: { input: CustomerInvoiceInput }, ctx: Ctx) => {
      const actor = authorize(ctx, "accounts:post", input.branchId);
      authorize(ctx, "invoice:create", input.branchId);
      return ctx.services.receivables.issueInvoice(actor, input);
    },
    issueCreditNote: async (_: unknown, { input }: { input: { invoiceId: string; reason: string; lines?: { itemIndex: number; taxablePaise?: number | null }[] | null; date?: Date | null } }, ctx: Ctx) => {
      const inv = await ctx.services.billing.get(actorOf(ctx), input.invoiceId);
      return ctx.services.receivables.issueCreditNote(authorize(ctx, "accounts:post", inv.branchId), input);
    },

    createPartner: (_: unknown, { input }: { input: PartnerInput }, ctx: Ctx) => ctx.services.settlements.createPartner(authorize(ctx, "accounts:manage", input.branchId), input),
    updatePartner: async (_: unknown, a: { id: string; input: Partial<PartnerInput> & { active?: boolean | null } }, ctx: Ctx) => {
      const p = await ctx.services.settlements.partner(actorOf(ctx), a.id);
      return ctx.services.settlements.updatePartner(authorize(ctx, "accounts:manage", p.branchId), a.id, a.input);
    },
    addAgreement: async (_: unknown, { input }: { input: AgreementInput }, ctx: Ctx) => {
      const p = await ctx.services.settlements.partner(actorOf(ctx), input.partnerId);
      return ctx.services.settlements.addAgreement(authorize(ctx, "accounts:manage", p.branchId), input);
    },
    createSettlement: async (_: unknown, a: { partnerId: string; period: string; deductions?: SettlementDeduction[] | null }, ctx: Ctx) => {
      const p = await ctx.services.settlements.partner(actorOf(ctx), a.partnerId);
      return ctx.services.settlements.create(authorize(ctx, "accounts:post", p.branchId), a);
    },
    accrueSettlement: async (_: unknown, a: { id: string }, ctx: Ctx) => (await settlementFor(ctx, a.id, "accounts:post"), ctx.services.settlements.accrue(actorOf(ctx), a.id)),
    paySettlement: async (_: unknown, { input }: { input: { settlementId: string; mode: never; date?: Date | null; reference?: string | null } }, ctx: Ctx) => {
      await settlementFor(ctx, input.settlementId, "accounts:post");
      return ctx.services.settlements.pay(actorOf(ctx), input);
    },
    cancelSettlement: async (_: unknown, a: { id: string }, ctx: Ctx) => (await settlementFor(ctx, a.id, "accounts:post"), ctx.services.settlements.cancel(actorOf(ctx), a.id)),

    closeCashDay: (_: unknown, { input }: { input: { branchId: string; day: string; countedPaise: number; denominations?: { valuePaise: number; count: number }[] | null; notes?: string | null } }, ctx: Ctx) =>
      ctx.services.cashBank.closeCashDay(authorize(ctx, "accounts:post", input.branchId), input),
    importBankStatement: async (_: unknown, { input }: { input: { branchId: string; ledgerId: string; csv: string; fileName?: string | null } }, ctx: Ctx) => {
      const actor = authorize(ctx, "accounts:post", input.branchId);
      await ctx.services.books.ledger(actor, input.ledgerId);
      return ctx.services.cashBank.importBankStatement(actor, input);
    },
    reconcileBank: (_: unknown, a: { ledgerId: string; statementId?: string | null }, ctx: Ctx) => ctx.services.cashBank.reconcile(authorize(ctx, "accounts:post"), a),
    matchBankLine: (_: unknown, a: { lineId: string; voucherIds: string[] }, ctx: Ctx) => ctx.services.cashBank.matchLine(authorize(ctx, "accounts:post"), a),
    setBankLineStatus: (_: unknown, a: { lineId: string; status: "ignored" | "unmatched" }, ctx: Ctx) => ctx.services.cashBank.setLineStatus(authorize(ctx, "accounts:post"), a),

    setLockDate: (_: unknown, { input }: { input: { branchId?: string | null; upTo: string | null; reason?: string | null } }, ctx: Ctx) =>
      ctx.services.periods.setLockDate(authorize(ctx, "accounts:manage", input.branchId), input),
    closeFinancialYear: (_: unknown, a: { fy: string }, ctx: Ctx) => ctx.services.periods.closeFinancialYear(authorize(ctx, "accounts:manage"), a.fy),
  },
});
