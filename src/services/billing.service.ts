import { getTestByCode } from "@mgpl-diagnostics/catalog-kit";
import {
  cancelInvoice, issueInvoice, recordPayment, ValidationError,
  type Id, type Invoice, type InvoiceStatus, type ItemCategory, type ItemInput, type PaymentMode, type Repositories, type Taxability,
} from "@mgpl-diagnostics/db-kit";
import { applyTaxRules } from "@mgpl-diagnostics/finance-kit";
import type { Actor } from "../graphql/context";
import { clean, mustOwn, scopedFind } from "./util";

export interface InvoiceItemInput {
  code?: string | null;
  name?: string | null;
  category?: ItemCategory | null;
  qty?: number | null;
  ratePaise?: number | null;
  discountPaise?: number | null;
  taxPercent?: number | null;
  hsnSac?: string | null;
  taxability?: Taxability | null;
}

export interface PaymentInput {
  amountPaise: number;
  mode: PaymentMode;
  reference?: string | null;
}

export interface IssueInvoiceInput {
  branchId: Id;
  patientId: Id;
  bookingId?: Id | null;
  items: InvoiceItemInput[];
  billDiscountPaise?: number | null;
  payments?: PaymentInput[] | null;
  /** Fill GST (HSN/SAC, taxability, rate) from finance-kit's tax rules. */
  applyTaxRules?: boolean | null;
}

/** An invoice line; a catalog-kit test code alone is enough (name and MRP from the catalog). */
export function invoiceItem(i: InvoiceItemInput): ItemInput {
  const cat = i.code && (i.name == null || i.ratePaise == null) ? getTestByCode(i.code) : undefined;
  const name = i.name ?? cat?.name;
  const ratePaise = i.ratePaise ?? (cat?.mrp != null ? cat.mrp * 100 : undefined);
  if (!name || ratePaise == null) throw new ValidationError(`Item ${i.code ?? "(no code)"} is not in the catalog; send its name and ratePaise`);
  return clean({
    code: i.code, name, category: i.category ?? "test", qty: i.qty ?? 1, ratePaise, discountPaise: i.discountPaise ?? 0,
    taxPercent: i.taxPercent ?? 0, hsnSac: i.hsnSac, taxability: i.taxability,
  }) as ItemInput;
}

const paymentOf = (p: PaymentInput) => clean({ amountPaise: p.amountPaise, mode: p.mode, reference: p.reference }) as { amountPaise: number; mode: PaymentMode; reference?: string };

/** Patient invoices and payments (db-kit workflows; posting to the books happens inside them). */
export class BillingService {
  constructor(private readonly repos: Repositories) {}

  async get(actor: Actor, id: Id) {
    return mustOwn(await this.repos.invoices.get(id), actor.orgId, "Invoice", id);
  }

  list(actor: Actor, q: { scope: "all" | Id[]; status?: InvoiceStatus | null; patientId?: Id | null; customerId?: Id | null; limit: number; offset: number }) {
    return scopedFind(this.repos.invoices, clean({ orgId: actor.orgId, status: q.status, patientId: q.patientId, customerId: q.customerId }), q.scope, q.limit, q.offset, "createdAt");
  }

  payments(invoiceId: Id) {
    return this.repos.payments.find({ invoiceId }, { sort: { field: "receivedAt" } });
  }

  vouchers(invoiceId: Id) {
    return this.repos.vouchers.find({ invoiceId } as never, { sort: { field: "date" } });
  }

  creditNotes(invoiceId: Id) {
    return this.repos.creditNotes.find({ invoiceId } as never, { sort: { field: "date" } });
  }

  async issue(actor: Actor, input: IssueInvoiceInput) {
    mustOwn(await this.repos.branches.get(input.branchId), actor.orgId, "Branch", input.branchId);
    mustOwn(await this.repos.patients.get(input.patientId), actor.orgId, "Patient", input.patientId);
    if (input.bookingId) mustOwn(await this.repos.bookings.get(input.bookingId), actor.orgId, "Booking", input.bookingId);
    let items = input.items.map(invoiceItem);
    if (input.applyTaxRules) items = await applyTaxRules(this.repos, actor.orgId, items);
    const { invoice } = await issueInvoice(this.repos, {
      orgId: actor.orgId, branchId: input.branchId, patientId: input.patientId, bookingId: input.bookingId ?? null,
      items, billDiscountPaise: input.billDiscountPaise ?? 0, payments: input.payments?.map(paymentOf),
    }, actor.userId);
    return invoice;
  }

  async pay(actor: Actor, invoice: Invoice, payment: PaymentInput, kind: "payment" | "refund") {
    return (await recordPayment(this.repos, { invoiceId: invoice.id, ...paymentOf(payment), kind }, actor.userId)).invoice;
  }

  cancel(actor: Actor, invoice: Invoice, reason: string) {
    if (!reason.trim()) throw new ValidationError("Give a reason");
    return cancelInvoice(this.repos, invoice.id, reason.trim(), actor.userId);
  }

  /** Is any discount on this request? (Discounts need the invoice:discount permission.) */
  static discounted(input: Pick<IssueInvoiceInput, "billDiscountPaise" | "items">) {
    return (input.billDiscountPaise ?? 0) > 0 || input.items.some((i) => (i.discountPaise ?? 0) > 0);
  }
}
