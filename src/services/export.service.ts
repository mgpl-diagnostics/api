import type { Id, Repositories } from "@mgpl-diagnostics/db-kit";
import {
  balanceSheetCsv, dayBookCsv, gstr1, gstr1Csv, gstr3b, gstr3bCsv, ledgerCsv, profitAndLossCsv, settlementCsv, trialBalanceCsv,
} from "@mgpl-diagnostics/finance-kit";
import type { Actor } from "../graphql/context";

export interface CsvFile {
  fileName: string;
  mimeType: string;
  content: string;
}

const csv = (fileName: string, content: string): CsvFile => ({ fileName, mimeType: "text/csv; charset=utf-8", content });
const day = (d: Date) => d.toISOString().slice(0, 10);

/** CSV exports (finance-kit): every file ends with a TOTAL row equal to its report. */
export class ExportService {
  constructor(private readonly repos: Repositories) {}

  async dayBook(actor: Actor, q: { from: Date; to: Date; branchId?: Id | null; bom: boolean }) {
    return csv(`day-book-${day(q.from)}-${day(q.to)}.csv`, await dayBookCsv(this.repos, { orgId: actor.orgId, from: q.from, to: q.to, branchId: q.branchId ?? undefined, bom: q.bom }));
  }

  async ledger(actor: Actor, q: { ledgerId: Id; from: Date; to: Date; branchId?: Id | null; bom: boolean }) {
    return csv(`ledger-${day(q.from)}-${day(q.to)}.csv`, await ledgerCsv(this.repos, { orgId: actor.orgId, ledgerId: q.ledgerId, from: q.from, to: q.to, branchId: q.branchId ?? undefined, bom: q.bom }));
  }

  async trialBalance(actor: Actor, q: { asOf?: Date | null; branchId?: Id | null; bom: boolean }) {
    return csv(`trial-balance${q.asOf ? `-${day(q.asOf)}` : ""}.csv`, await trialBalanceCsv(this.repos, { orgId: actor.orgId, asOf: q.asOf ?? undefined, branchId: q.branchId ?? undefined, bom: q.bom }));
  }

  async profitAndLoss(actor: Actor, q: { from: Date; to: Date; branchId?: Id | null; bom: boolean }) {
    return csv(`profit-and-loss-${day(q.from)}-${day(q.to)}.csv`, await profitAndLossCsv(this.repos, { orgId: actor.orgId, from: q.from, to: q.to, branchId: q.branchId ?? undefined, bom: q.bom }));
  }

  async balanceSheet(actor: Actor, q: { asOf: Date; branchId?: Id | null; bom: boolean }) {
    return csv(`balance-sheet-${day(q.asOf)}.csv`, await balanceSheetCsv(this.repos, { orgId: actor.orgId, asOf: q.asOf, branchId: q.branchId ?? undefined, bom: q.bom }));
  }

  async settlement(actor: Actor, q: { settlementId: Id; bom: boolean }) {
    return csv(`settlement-${q.settlementId}.csv`, await settlementCsv(this.repos, { orgId: actor.orgId, settlementId: q.settlementId, bom: q.bom }));
  }

  /** One file per GSTR-1 section (b2b, b2cl, b2cs, cdnr, cdnur, nil, hsn, docs). */
  async gstr1(actor: Actor, q: { from: Date; to: Date; gstin?: string | null; bom: boolean }) {
    const r = await gstr1(this.repos, { orgId: actor.orgId, from: q.from, to: q.to, gstin: q.gstin ?? undefined });
    return Object.entries(gstr1Csv(r, { bom: q.bom })).map(([section, content]) => csv(`gstr1-${section}-${day(q.from)}-${day(q.to)}.csv`, content));
  }

  async gstr3b(actor: Actor, q: { from: Date; to: Date; gstin?: string | null; bom: boolean }) {
    const r = await gstr3b(this.repos, { orgId: actor.orgId, from: q.from, to: q.to, gstin: q.gstin ?? undefined });
    return csv(`gstr3b-${day(q.from)}-${day(q.to)}.csv`, gstr3bCsv(r, { bom: q.bom }));
  }
}
