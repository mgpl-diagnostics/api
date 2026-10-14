import type { Address, CustomerKind, Id, Repositories } from "@mgpl-diagnostics/db-kit";
import { createCustomer, customerStatement, issueCreditNote, issueCustomerInvoice, receivablesSummary, updateCustomer } from "@mgpl-diagnostics/finance-kit";
import type { Actor } from "../graphql/context";
import { invoiceItem, type IssueInvoiceInput } from "./billing.service";
import { clean, mustOwn } from "./util";

export interface CustomerInput {
  code: string;
  name: string;
  kind: CustomerKind;
  legalName?: string | null;
  gstin?: string | null;
  stateCode?: string | null;
  pan?: string | null;
  phone?: string | null;
  email?: string | null;
  address?: Address | null;
  creditLimitPaise?: number | null;
  creditDays?: number | null;
}

export interface CustomerInvoiceInput extends Omit<IssueInvoiceInput, "applyTaxRules"> {
  customerId: Id;
  placeOfSupply?: string | null;
  /** Default true: GST from the tax rules. */
  applyTaxRules?: boolean | null;
}

/** B2B receivables (hospitals, insurers, TPAs, corporates) and credit notes, through finance-kit. */
export class ReceivablesService {
  constructor(private readonly repos: Repositories) {}

  customers(actor: Actor, activeOnly: boolean) {
    return this.repos.customers.find(activeOnly ? { orgId: actor.orgId, active: true } : { orgId: actor.orgId }, { sort: { field: "code" } });
  }

  async customer(actor: Actor, id: Id) {
    return mustOwn(await this.repos.customers.get(id), actor.orgId, "Customer", id);
  }

  createCustomer(actor: Actor, input: CustomerInput) {
    return createCustomer(this.repos, { ...(clean(input) as CustomerInput), orgId: actor.orgId } as never, actor.userId);
  }

  updateCustomer(actor: Actor, id: Id, patch: Partial<Omit<CustomerInput, "code">> & { active?: boolean | null }) {
    // creditLimitPaise: null means "no limit", so it is passed through when present
    const p = clean(patch) as Record<string, unknown>;
    if (patch.creditLimitPaise === null) p.creditLimitPaise = null;
    return updateCustomer(this.repos, { ...p, orgId: actor.orgId, customerId: id } as never, actor.userId);
  }

  async issueInvoice(actor: Actor, input: CustomerInvoiceInput) {
    const { invoice } = await issueCustomerInvoice(this.repos, {
      orgId: actor.orgId, branchId: input.branchId, patientId: input.patientId, bookingId: input.bookingId ?? null, customerId: input.customerId,
      items: input.items.map(invoiceItem), billDiscountPaise: input.billDiscountPaise ?? 0,
      payments: input.payments?.map((p) => clean(p)) as never, placeOfSupply: input.placeOfSupply ?? undefined, applyTaxRules: input.applyTaxRules ?? true,
    }, actor.userId);
    return invoice;
  }

  statement(actor: Actor, q: { customerId: Id; from: Date; to: Date }) {
    return customerStatement(this.repos, { orgId: actor.orgId, ...q });
  }

  summary(actor: Actor, asOf: Date) {
    return receivablesSummary(this.repos, { orgId: actor.orgId, asOf });
  }

  async creditNote(actor: Actor, id: Id) {
    return mustOwn(await this.repos.creditNotes.get(id), actor.orgId, "Credit note", id);
  }

  creditNotes(actor: Actor, q: { invoiceId?: Id | null; customerId?: Id | null; limit: number; offset: number }) {
    return this.repos.creditNotes.find(clean({ orgId: actor.orgId, invoiceId: q.invoiceId, customerId: q.customerId }) as never, { limit: q.limit, offset: q.offset, sort: { field: "date", dir: "desc" } });
  }

  issueCreditNote(actor: Actor, input: { invoiceId: Id; reason: string; lines?: { itemIndex: number; taxablePaise?: number | null }[] | null; date?: Date | null }) {
    return issueCreditNote(this.repos, {
      orgId: actor.orgId, invoiceId: input.invoiceId, reason: input.reason, date: input.date ?? undefined,
      lines: input.lines?.map((l) => clean(l) as { itemIndex: number; taxablePaise?: number }),
    }, actor.userId);
  }
}
