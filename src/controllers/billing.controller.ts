import type { Invoice, InvoiceStatus } from "@mgpl-diagnostics/db-kit";
import type { RequestContext as Ctx } from "../graphql/context";
import { withErrorCodes } from "../graphql/errors";
import { actorOf, authorize, branchScope, canSee, cap } from "../graphql/guards";
import { BillingService, type IssueInvoiceInput, type PaymentInput } from "../services/billing.service";

async function invoiceFor(ctx: Ctx, id: string, permission: string) {
  const inv = await ctx.services.billing.get(actorOf(ctx), id);
  authorize(ctx, permission, inv.branchId);
  return inv;
}

/** Invoices and payments. */
export const billingController = withErrorCodes({
  Query: {
    invoice: (_: unknown, a: { id: string }, ctx: Ctx) => invoiceFor(ctx, a.id, "invoice:read"),
    invoices: (_: unknown, a: { branchId?: string | null; status?: InvoiceStatus | null; patientId?: string | null; customerId?: string | null; limit?: number; offset?: number }, ctx: Ctx) =>
      ctx.services.billing.list(actorOf(ctx), { scope: branchScope(ctx, "invoice:read", a.branchId), status: a.status, patientId: a.patientId, customerId: a.customerId, limit: cap(a.limit, 50), offset: a.offset ?? 0 }),
  },
  Invoice: {
    patient: (i: Invoice, _: unknown, ctx: Ctx) => ctx.loaders.patient.load(i.patientId),
    branch: (i: Invoice, _: unknown, ctx: Ctx) => ctx.loaders.branch.load(i.branchId),
    booking: (i: Invoice, _: unknown, ctx: Ctx) => ctx.loaders.booking.load(i.bookingId),
    customer: (i: Invoice, _: unknown, ctx: Ctx) => ctx.loaders.customer.load(i.customerId),
    creditedPaise: (i: Invoice) => i.creditedPaise ?? 0,
    payments: (i: Invoice, _: unknown, ctx: Ctx) => ctx.services.billing.payments(i.id),
    vouchers: (i: Invoice, _: unknown, ctx: Ctx) => (canSee(ctx, "accounts:read", i.branchId) ? ctx.services.billing.vouchers(i.id) : []),
    creditNotes: (i: Invoice, _: unknown, ctx: Ctx) => ctx.services.billing.creditNotes(i.id),
  },
  Mutation: {
    issueInvoice: (_: unknown, { input }: { input: IssueInvoiceInput }, ctx: Ctx) => {
      const actor = authorize(ctx, "invoice:create", input.branchId);
      if (BillingService.discounted(input)) authorize(ctx, "invoice:discount", input.branchId);
      if (input.payments?.length) authorize(ctx, "payment:create", input.branchId);
      return ctx.services.billing.issue(actor, input);
    },
    recordPayment: async (_: unknown, a: { invoiceId: string; payment: PaymentInput }, ctx: Ctx) =>
      ctx.services.billing.pay(actorOf(ctx), await invoiceFor(ctx, a.invoiceId, "payment:create"), a.payment, "payment"),
    refundPayment: async (_: unknown, a: { invoiceId: string; payment: PaymentInput }, ctx: Ctx) =>
      ctx.services.billing.pay(actorOf(ctx), await invoiceFor(ctx, a.invoiceId, "payment:refund"), a.payment, "refund"),
    cancelInvoice: async (_: unknown, a: { id: string; reason: string }, ctx: Ctx) =>
      ctx.services.billing.cancel(actorOf(ctx), await invoiceFor(ctx, a.id, "invoice:cancel"), a.reason),
  },
});
