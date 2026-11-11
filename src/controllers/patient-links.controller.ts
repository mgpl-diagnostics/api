import type { RequestContext as Ctx } from "../graphql/context";
import { badInput, withErrorCodes } from "../graphql/errors";
import { actorOf, authorize } from "../graphql/guards";

async function bookingFor(ctx: Ctx, id: string, ...permissions: string[]) {
  const b = await ctx.services.bookings.get(actorOf(ctx), id);
  for (const p of permissions) authorize(ctx, p, b.branchId);
  return b;
}

/** Patient links: two public fields (rate-limited per IP, null for any token that does not open) and two staff fields. */
export const patientLinksController = withErrorCodes({
  Query: {
    patientPage: async (_: unknown, a: { token: string }, ctx: Ctx) => {
      await ctx.services.patientLinks.throttle(ctx.ip);
      const v = await ctx.services.patientLinks.view(a.token);
      if (!v) return null;
      return {
        labName: v.labName, patientName: v.patientName, bookingNo: v.booking.bookingNo, bookedAt: v.booking.createdAt, branch: v.branch,
        invoices: v.invoices, reports: v.reports, pending: v.pending, expiresAt: v.link.expiresAt,
      };
    },
    patientDocument: async (_: unknown, a: { token: string; kind: "invoice" | "reports"; invoiceId?: string | null }, ctx: Ctx) => {
      await ctx.services.patientLinks.throttle(ctx.ip);
      if (a.kind === "invoice" && !a.invoiceId) throw badInput("invoiceId is required for kind invoice");
      const opened = await ctx.services.patientLinks.open(a.token);
      if (!opened) return null;
      return a.kind === "invoice" ? ctx.services.documents.patientInvoice(opened.link, a.invoiceId!) : ctx.services.documents.patientReports(opened.link);
    },
    patientLink: async (_: unknown, a: { bookingId: string }, ctx: Ctx) =>
      ctx.services.patientLinks.forBooking(actorOf(ctx), await bookingFor(ctx, a.bookingId, "booking:read", "report:read")),
  },
  Mutation: {
    revokePatientLinks: async (_: unknown, a: { bookingId: string }, ctx: Ctx) =>
      ctx.services.patientLinks.revoke(actorOf(ctx), await bookingFor(ctx, a.bookingId, "booking:update")),
  },
});
