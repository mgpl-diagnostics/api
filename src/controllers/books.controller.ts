import type { AccountGroup, Ledger, Voucher, VoucherEntry, VoucherType } from "@mgpl-diagnostics/db-kit";
import type { RequestContext as Ctx } from "../graphql/context";
import { withErrorCodes } from "../graphql/errors";
import { actorOf, authorize } from "../graphql/guards";
import type { PostVoucherInput } from "../services/books.service";

const BUCKET = { "0-30": "D0_30", "31-60": "D31_60", "61-90": "D61_90", "90+": "D90_PLUS" } as const;

type Range = { from: Date; to: Date; branchId?: string | null };

/** The books (ledger-kit). Reads need accounts:read, manual vouchers accounts:post, setup accounts:manage. */
export const booksController = withErrorCodes({
  Query: {
    accountGroups: (_: unknown, __: unknown, ctx: Ctx) => ctx.services.books.groups(authorize(ctx, "accounts:read")),
    ledgers: (_: unknown, __: unknown, ctx: Ctx) => ctx.services.books.ledgers(authorize(ctx, "accounts:read")),
    ledger: async (_: unknown, a: { id: string }, ctx: Ctx) => {
      const l = await ctx.loaders.ledger.load(a.id);
      return l && l.orgId === authorize(ctx, "accounts:read").orgId ? l : null;
    },
    voucher: async (_: unknown, a: { id: string }, ctx: Ctx) => {
      const v = await ctx.services.books.voucher(actorOf(ctx), a.id);
      authorize(ctx, "accounts:read", v.branchId);
      return v;
    },
    ledgerStatement: (_: unknown, a: Range & { ledgerId: string }, ctx: Ctx) => ctx.services.books.ledgerStatement(authorize(ctx, "accounts:read", a.branchId), a),
    cashBook: (_: unknown, a: Range, ctx: Ctx) => ctx.services.books.cashBook(authorize(ctx, "accounts:read", a.branchId), a),
    trialBalance: (_: unknown, a: { asOf?: Date | null; branchId?: string | null }, ctx: Ctx) => ctx.services.books.trialBalance(authorize(ctx, "accounts:read", a.branchId), a),
    profitAndLoss: (_: unknown, a: Range, ctx: Ctx) => ctx.services.books.profitAndLoss(authorize(ctx, "accounts:read", a.branchId), a),
    balanceSheet: (_: unknown, a: { asOf: Date; branchId?: string | null }, ctx: Ctx) => ctx.services.books.balanceSheet(authorize(ctx, "accounts:read", a.branchId), a),
    dayBook: (_: unknown, a: Range & { type?: VoucherType | null }, ctx: Ctx) => ctx.services.books.dayBook(authorize(ctx, "accounts:read", a.branchId), a),
    outstandingReceivables: async (_: unknown, a: { asOf?: Date | null; branchId?: string | null }, ctx: Ctx) => {
      const out = await ctx.services.books.outstanding(authorize(ctx, "accounts:read", a.branchId), a);
      return {
        rows: out.rows.map((r) => ({ ...r, bucket: BUCKET[r.bucket] })),
        buckets: { d0to30: out.buckets["0-30"], d31to60: out.buckets["31-60"], d61to90: out.buckets["61-90"], d90plus: out.buckets["90+"] },
        totalDuePaise: out.totalDuePaise,
      };
    },
    gstSummary: (_: unknown, a: Range, ctx: Ctx) => ctx.services.books.gstSummary(authorize(ctx, "accounts:read", a.branchId), a),
  },
  AccountGroup: {
    parent: (g: AccountGroup, _: unknown, ctx: Ctx) => ctx.loaders.group.load(g.parentId),
  },
  Ledger: {
    group: (l: Ledger, _: unknown, ctx: Ctx) => ctx.loaders.group.load(l.groupId),
    balancePaise: (l: Ledger, a: { asOf?: Date | null; branchId?: string | null }, ctx: Ctx) => ctx.services.books.balance(l.orgId, l.id, a),
  },
  Voucher: {
    branch: (v: Voucher, _: unknown, ctx: Ctx) => ctx.loaders.branch.load(v.branchId),
  },
  VoucherEntry: {
    ledger: (e: VoucherEntry, _: unknown, ctx: Ctx) => ctx.loaders.ledger.load(e.ledgerId),
  },
  Mutation: {
    setupChartOfAccounts: (_: unknown, __: unknown, ctx: Ctx) => ctx.services.books.setupChartOfAccounts(authorize(ctx, "accounts:manage")),
    createLedger: (_: unknown, { input }: { input: { name: string; groupId: string; openingPaise?: number | null; gstin?: string | null } }, ctx: Ctx) =>
      ctx.services.books.createLedger(authorize(ctx, "accounts:manage"), input),
    postVoucher: (_: unknown, { input }: { input: PostVoucherInput }, ctx: Ctx) => ctx.services.books.postVoucher(authorize(ctx, "accounts:post", input.branchId), input),
    cancelVoucher: async (_: unknown, a: { id: string }, ctx: Ctx) => {
      const v = await ctx.services.books.voucher(actorOf(ctx), a.id);
      return ctx.services.books.cancelVoucher(authorize(ctx, "accounts:post", v.branchId), a.id);
    },
  },
});
