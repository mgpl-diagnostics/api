import type { BankLineStatus, CashDenomination, Id, Repositories } from "@mgpl-diagnostics/db-kit";
import { bankReconciliation, closeCashDay, importBankStatement, matchBankLine, reconcileBank, setBankLineStatus } from "@mgpl-diagnostics/finance-kit";
import type { Actor } from "../graphql/context";
import { clean, mustOwn } from "./util";

/** Day-end cash closing and bank reconciliation, through finance-kit. */
export class CashBankService {
  constructor(private readonly repos: Repositories) {}

  closeCashDay(actor: Actor, input: { branchId: Id; day: string; countedPaise: number; denominations?: CashDenomination[] | null; notes?: string | null }) {
    return closeCashDay(this.repos, { ...(clean(input) as typeof input), orgId: actor.orgId } as never, actor.userId);
  }

  cashClosings(actor: Actor, q: { branchId: Id; limit: number; offset: number }) {
    return this.repos.cashClosings.find({ orgId: actor.orgId, branchId: q.branchId }, { limit: q.limit, offset: q.offset, sort: { field: "day", dir: "desc" } });
  }

  importBankStatement(actor: Actor, input: { branchId: Id; ledgerId: Id; csv: string; fileName?: string | null }) {
    return importBankStatement(this.repos, { orgId: actor.orgId, branchId: input.branchId, ledgerId: input.ledgerId, csv: input.csv, fileName: input.fileName ?? undefined }, actor.userId);
  }

  async bankStatement(actor: Actor, id: Id) {
    return mustOwn(await this.repos.bankStatements.get(id), actor.orgId, "Bank statement", id);
  }

  bankStatements(actor: Actor, q: { ledgerId?: Id | null; limit: number; offset: number }) {
    return this.repos.bankStatements.find(clean({ orgId: actor.orgId, ledgerId: q.ledgerId }) as never, { limit: q.limit, offset: q.offset, sort: { field: "createdAt", dir: "desc" } });
  }

  bankLines(actor: Actor, q: { ledgerId?: Id | null; statementId?: Id | null; status?: BankLineStatus | null; limit: number; offset: number }) {
    return this.repos.bankLines.find(clean({ orgId: actor.orgId, ledgerId: q.ledgerId, statementId: q.statementId, status: q.status }) as never, { limit: q.limit, offset: q.offset, sort: { field: "date", dir: "desc" } });
  }

  async bankLine(actor: Actor, id: Id) {
    return mustOwn(await this.repos.bankLines.get(id), actor.orgId, "Bank line", id);
  }

  reconcile(actor: Actor, q: { ledgerId: Id; statementId?: Id | null }) {
    return reconcileBank(this.repos, { orgId: actor.orgId, ledgerId: q.ledgerId, statementId: q.statementId ?? undefined }, actor.userId);
  }

  matchLine(actor: Actor, q: { lineId: Id; voucherIds: Id[] }) {
    return matchBankLine(this.repos, { orgId: actor.orgId, ...q }, actor.userId);
  }

  setLineStatus(actor: Actor, q: { lineId: Id; status: "ignored" | "unmatched" }) {
    return setBankLineStatus(this.repos, { orgId: actor.orgId, ...q }, actor.userId);
  }

  reconciliation(actor: Actor, q: { ledgerId: Id; asOf: Date }) {
    return bankReconciliation(this.repos, { orgId: actor.orgId, ...q });
  }
}
