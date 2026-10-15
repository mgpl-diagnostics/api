import { NotFoundError, type Id, type Repositories, type VoucherEntry, type VoucherType } from "@mgpl-diagnostics/db-kit";
import { seedFinanceLedgers } from "@mgpl-diagnostics/finance-kit";
import {
  balanceSheet, cancelVoucher, cashBook, dayBook, gstSummary, ledgerBalance, ledgerStatement, outstandingReceivables, postVoucher, profitAndLoss, trialBalance,
} from "@mgpl-diagnostics/ledger-kit";
import type { Actor } from "../graphql/context";
import { mustOwn } from "./util";

export interface PostVoucherInput {
  branchId: Id;
  type: VoucherType;
  date?: Date | null;
  narration?: string | null;
  entries: { ledgerId: Id; debitPaise?: number | null; creditPaise?: number | null; invoiceId?: Id | null }[];
}

/**
 * The books, through ledger-kit (our accounting engine): chart of accounts, ledgers, manual vouchers
 * and the books reports. Automatic posting of invoices and payments happens inside db-kit's workflows
 * through finance-kit's posting hook (set in the container).
 */
export class BooksService {
  constructor(private readonly repos: Repositories) {}

  groups(actor: Actor) {
    return this.repos.accountGroups.find({ orgId: actor.orgId }, { sort: { field: "name" } });
  }

  ledgers(actor: Actor) {
    return this.repos.ledgers.find({ orgId: actor.orgId }, { sort: { field: "name" } });
  }

  async ledger(actor: Actor, id: Id) {
    return mustOwn(await this.repos.ledgers.get(id), actor.orgId, "Ledger", id);
  }

  /** The standard chart (28 groups, default ledgers) plus finance-kit's ledgers. Idempotent. */
  setupChartOfAccounts(actor: Actor) {
    return seedFinanceLedgers(this.repos, actor.orgId);
  }

  async createLedger(actor: Actor, input: { name: string; groupId: Id; openingPaise?: number | null; gstin?: string | null }) {
    mustOwn(await this.repos.accountGroups.get(input.groupId), actor.orgId, "Account group", input.groupId);
    const l = await this.repos.ledgers.create({ orgId: actor.orgId, name: input.name.trim(), groupId: input.groupId, openingPaise: input.openingPaise ?? 0, gstin: input.gstin ?? undefined, systemKey: null, active: true } as never);
    await this.repos.audit.log({ orgId: actor.orgId, userId: actor.userId, action: "ledger.create", entity: "ledger", entityId: l.id });
    return l;
  }

  async postVoucher(actor: Actor, input: PostVoucherInput) {
    mustOwn(await this.repos.branches.get(input.branchId), actor.orgId, "Branch", input.branchId);
    await this.assertOwnLedgers(actor, input.entries.map((e) => e.ledgerId)); // no posting into another organisation's books
    for (const e of input.entries) if (e.invoiceId) mustOwn(await this.repos.invoices.get(e.invoiceId), actor.orgId, "Invoice", e.invoiceId);
    const entries: VoucherEntry[] = input.entries.map((e) => ({ ledgerId: e.ledgerId, debitPaise: e.debitPaise ?? 0, creditPaise: e.creditPaise ?? 0, invoiceId: e.invoiceId ?? null }));
    return postVoucher(this.repos, { orgId: actor.orgId, branchId: input.branchId, type: input.type, date: input.date ?? undefined, narration: input.narration ?? undefined, entries }, actor.userId);
  }

  async voucher(actor: Actor, id: Id) {
    return mustOwn(await this.repos.vouchers.get(id), actor.orgId, "Voucher", id);
  }

  cancelVoucher(actor: Actor, id: Id) {
    return cancelVoucher(this.repos, id, actor.userId);
  }

  // ---------------------------------------------------------------- reports (ledger-kit)

  balance(orgId: Id, ledgerId: Id, q: { asOf?: Date | null; branchId?: Id | null }) {
    return ledgerBalance(this.repos, { orgId, ledgerId, asOf: q.asOf ?? undefined, branchId: q.branchId ?? undefined });
  }

  async ledgerStatement(actor: Actor, q: { ledgerId: Id; from: Date; to: Date; branchId?: Id | null }) {
    await this.assertOwnLedgers(actor, [q.ledgerId]);
    return ledgerStatement(this.repos, { orgId: actor.orgId, ledgerId: q.ledgerId, from: q.from, to: q.to, branchId: q.branchId ?? undefined });
  }

  cashBook(actor: Actor, q: { from: Date; to: Date; branchId?: Id | null }) {
    return cashBook(this.repos, { orgId: actor.orgId, from: q.from, to: q.to, branchId: q.branchId ?? undefined });
  }

  trialBalance(actor: Actor, q: { asOf?: Date | null; branchId?: Id | null }) {
    return trialBalance(this.repos, { orgId: actor.orgId, asOf: q.asOf ?? undefined, branchId: q.branchId ?? undefined });
  }

  profitAndLoss(actor: Actor, q: { from: Date; to: Date; branchId?: Id | null }) {
    return profitAndLoss(this.repos, { orgId: actor.orgId, from: q.from, to: q.to, branchId: q.branchId ?? undefined });
  }

  balanceSheet(actor: Actor, q: { asOf: Date; branchId?: Id | null }) {
    return balanceSheet(this.repos, { orgId: actor.orgId, asOf: q.asOf, branchId: q.branchId ?? undefined });
  }

  dayBook(actor: Actor, q: { from: Date; to: Date; branchId?: Id | null; type?: VoucherType | null }) {
    return dayBook(this.repos, { orgId: actor.orgId, from: q.from, to: q.to, branchId: q.branchId ?? undefined, type: q.type ?? undefined });
  }

  outstanding(actor: Actor, q: { asOf?: Date | null; branchId?: Id | null }) {
    return outstandingReceivables(this.repos, { orgId: actor.orgId, asOf: q.asOf ?? undefined, branchId: q.branchId ?? undefined });
  }

  gstSummary(actor: Actor, q: { from: Date; to: Date; branchId?: Id | null }) {
    return gstSummary(this.repos, { orgId: actor.orgId, from: q.from, to: q.to, branchId: q.branchId ?? undefined });
  }

  private async assertOwnLedgers(actor: Actor, ids: Id[]) {
    const unique = [...new Set(ids)];
    const found = await this.repos.ledgers.getMany(unique);
    const bad = unique.find((id) => !found.some((l) => l.id === id && l.orgId === actor.orgId));
    if (bad) throw new NotFoundError("Ledger", bad);
  }
}
