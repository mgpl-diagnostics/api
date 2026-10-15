import type { InvoiceRequest } from "@mgpl-diagnostics/invoice-kit";
import type { ReportDesign, ReportRequest, ReportVariant } from "@mgpl-diagnostics/report-kit";
import type { RequestContext as Ctx } from "../graphql/context";
import { badInput, withErrorCodes } from "../graphql/errors";
import { actorOf, authorize } from "../graphql/guards";
import type { DocumentFormat } from "../services/document.service";

type Opts = { format?: DocumentFormat; variant?: "header" | "non_header"; design?: ReportDesign; fileName?: string | null };

const variantOf = (v?: string): ReportVariant => (v === "non_header" ? "non-header" : "header");
const options = (a: Opts) => ({ format: a.format ?? "pdf", variant: variantOf(a.variant), design: a.design ?? "sidebar", fileName: a.fileName });
const objectOf = <T>(v: unknown, what: string): T => {
  if (!v || typeof v !== "object" || Array.isArray(v)) throw badInput(`${what} must be a JSON object`);
  return v as T;
};

/** report-kit and invoice-kit, used as internal libraries behind this one endpoint. */
export const documentsController = withErrorCodes({
  Query: {
    job: (_: unknown, a: { id: string }, ctx: Ctx) => ctx.services.jobs.get(actorOf(ctx), a.id),
    reportTemplates: (_: unknown, __: unknown, ctx: Ctx) => (actorOf(ctx), ctx.services.documents.templates()),
    priceList: (_: unknown, __: unknown, ctx: Ctx) => (actorOf(ctx), ctx.services.documents.priceList()),
    documentSamples: (_: unknown, __: unknown, ctx: Ctx) => (actorOf(ctx), ctx.services.documents.reportSamples()),
    invoiceSamples: (_: unknown, __: unknown, ctx: Ctx) => (actorOf(ctx), ctx.services.documents.invoiceSamples()),

    renderReport: (_: unknown, a: Opts & { request: unknown }, ctx: Ctx) => {
      authorize(ctx, "report:read");
      return ctx.services.documents.renderReportRequest(objectOf<ReportRequest>(a.request, "request"), options(a));
    },
    renderInvoice: (_: unknown, a: Opts & { request: unknown }, ctx: Ctx) => {
      authorize(ctx, "invoice:read");
      return ctx.services.documents.renderInvoiceRequest(objectOf<InvoiceRequest>(a.request, "request"), options(a));
    },
    invoiceTotals: (_: unknown, a: { request: unknown }, ctx: Ctx) => {
      authorize(ctx, "invoice:read");
      return ctx.services.documents.invoiceTotals(objectOf<InvoiceRequest>(a.request, "request"));
    },
    letterhead: (_: unknown, a: { format?: DocumentFormat }, ctx: Ctx) => {
      authorize(ctx, "report:read");
      return ctx.services.documents.letterhead(a.format ?? "pdf");
    },

    invoiceDocument: async (_: unknown, a: Opts & { invoiceId: string }, ctx: Ctx) => {
      const inv = await ctx.services.billing.get(actorOf(ctx), a.invoiceId);
      return ctx.services.documents.renderStoredInvoice(authorize(ctx, "invoice:read", inv.branchId), inv, options(a));
    },
    bookingReportDocument: async (_: unknown, a: Opts & { bookingId: string; reportIds?: string[] | null }, ctx: Ctx) => {
      const b = await ctx.services.bookings.get(actorOf(ctx), a.bookingId);
      return ctx.services.documents.renderBookingReports(authorize(ctx, "report:read", b.branchId), a.bookingId, a.reportIds ?? null, options(a));
    },
  },
  Mutation: {
    startDocumentJob: async (_: unknown, { input: a }: { input: Opts & { kind: "invoice" | "booking_reports"; invoiceId?: string | null; bookingId?: string | null; reportIds?: string[] | null } }, ctx: Ctx) => {
      if (a.kind === "invoice") {
        if (!a.invoiceId) throw badInput("invoiceId is required for kind invoice");
        const inv = await ctx.services.billing.get(actorOf(ctx), a.invoiceId);
        return ctx.services.jobs.invoiceDocument(authorize(ctx, "invoice:read", inv.branchId), inv.id, options(a));
      }
      if (!a.bookingId) throw badInput("bookingId is required for kind booking_reports");
      const b = await ctx.services.bookings.get(actorOf(ctx), a.bookingId);
      return ctx.services.jobs.bookingReports(authorize(ctx, "report:read", b.branchId), b.id, a.reportIds ?? null, options(a));
    },
  },
  TemplateField: {
    range: (f: { range?: string | string[] }) => (f.range == null ? null : Array.isArray(f.range) ? f.range : [f.range]),
  },
});
