import { getTestByCode } from "@mgpl-diagnostics/catalog-kit";
import {
  ConflictError, NotFoundError, ValidationError,
  type Id, type Invoice as DbInvoice, type Patient as DbPatient, type PaymentMode, type Report as DbReport, type Repositories,
} from "@mgpl-diagnostics/db-kit";
import {
  computeInvoice, INVOICE_SAMPLES, invoiceFromRequest, invoiceTotalsJson, PRICE_LIST, renderInvoiceHtml, renderInvoicePdf,
  type Invoice as PrintInvoice, type InvoiceItem as PrintItem, type InvoiceRequest,
} from "@mgpl-diagnostics/invoice-kit";
import {
  buildReport, COLS_STD, defaultLab, renderLetterheadHtml, renderLetterheadPdf, renderReportHtml, renderReportPdf, reportFromRequest, SAMPLES, templateCatalog, TEMPLATES,
  type LabProfile, type Patient as PrintPatient, type Report as PrintReport, type ReportDesign, type ReportRequest, type ReportVariant, type Section, type TestRow,
} from "@mgpl-diagnostics/report-kit";
import type { Actor } from "../graphql/context";
import { mustOwn } from "./util";

export type DocumentFormat = "pdf" | "html";

/** A rendered document. PDFs travel as base64 in `base64`; HTML (self-contained, fonts inlined) in `html`. */
export interface RenderedDocument {
  format: DocumentFormat;
  fileName: string;
  mimeType: string;
  byteLength: number;
  base64: string | null;
  html: string | null;
}

export interface RenderOptions {
  format: DocumentFormat;
  variant: ReportVariant;
  design?: ReportDesign;
  fileName?: string | null;
}

const MODE_LABEL: Record<PaymentMode, string> = { cash: "Cash", upi: "UPI", card: "Card", netbanking: "Online", wallet: "Wallet", cheque: "Cheque", insurance: "Insurance" };
const rupees = (paise: number) => paise / 100;
const titleCase = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

function ageOf(p: DbPatient, at: Date): number | string {
  if (p.ageYears != null) return p.ageYears;
  if (!p.dob) return "";
  const dob = new Date(p.dob);
  let years = at.getUTCFullYear() - dob.getUTCFullYear();
  if (at.getUTCMonth() < dob.getUTCMonth() || (at.getUTCMonth() === dob.getUTCMonth() && at.getUTCDate() < dob.getUTCDate())) years--;
  return Math.max(0, years);
}

/** db-kit patient → the printed patient block. */
export function printPatient(p: DbPatient, at: Date, extra: Partial<PrintPatient> = {}): PrintPatient {
  return {
    title: p.title, name: p.name, age: ageOf(p, at), sex: titleCase(p.sex), patientId: p.uhid, phone: p.phone,
    address: [p.address?.line1, p.address?.city].filter(Boolean).join(", ") || undefined, ...extra,
  };
}

/**
 * report-kit (lab reports, letterhead) and invoice-kit (invoices) used as internal libraries: render
 * from a request (any data) or from what is stored in db-kit (an invoice, a booking's reports).
 */
export class DocumentService {
  private readonly lab: LabProfile;
  private readonly samples: boolean;

  constructor(private readonly repos: Repositories, opts: { lab?: LabProfile; samples: boolean }) {
    this.lab = opts.lab ?? defaultLab();
    this.samples = opts.samples;
  }

  // ---------------------------------------------------------------- catalogs

  templates() {
    return templateCatalog();
  }

  priceList() {
    return Object.entries(PRICE_LIST).map(([code, e]) => ({ code, ...e }));
  }

  reportSamples() {
    return this.samples ? SAMPLES.map((s) => ({ id: s.id, label: s.label, group: s.group })) : [];
  }

  invoiceSamples() {
    return this.samples ? INVOICE_SAMPLES.map((s) => ({ id: s.id, label: s.label, invoiceNo: s.invoice.invoiceNo })) : [];
  }

  // ---------------------------------------------------------------- from a request

  renderReportRequest(request: ReportRequest, o: RenderOptions) {
    return this.renderReport(reportFromRequest(request, { samples: this.samples }), o);
  }

  renderInvoiceRequest(request: InvoiceRequest, o: RenderOptions) {
    return this.renderInvoice(invoiceFromRequest(request, { samples: this.samples }), o);
  }

  /** invoice-kit's calculation (integer paise inside, rupees out) without rendering. */
  invoiceTotals(request: InvoiceRequest) {
    return invoiceTotalsJson(invoiceFromRequest(request, { samples: this.samples }));
  }

  async letterhead(format: DocumentFormat): Promise<RenderedDocument> {
    if (format === "html") return htmlDoc("letterhead.html", await renderLetterheadHtml({ lab: this.lab, inline: true }));
    return pdfDoc("letterhead.pdf", await renderLetterheadPdf({ lab: this.lab }));
  }

  // ---------------------------------------------------------------- from stored data

  /** The printed form of a stored invoice (with its payments). */
  async storedInvoice(actor: Actor, invoice: DbInvoice): Promise<PrintInvoice> {
    const patient = mustOwn(await this.repos.patients.get(invoice.patientId), actor.orgId, "Patient", invoice.patientId);
    const payments = await this.repos.payments.find({ invoiceId: invoice.id }, { sort: { field: "receivedAt" } });
    const at = invoice.issuedAt ?? invoice.createdAt;
    const lineDiscounts = invoice.items.reduce((s, i) => s + i.discountPaise, 0);
    const billDiscount = invoice.discountPaise - lineDiscounts;
    const refunded = payments.filter((p) => p.kind === "refund").reduce((s, p) => s + p.amountPaise, 0);
    const items: PrintItem[] = invoice.items.map((i) => ({
      code: i.code, name: i.name, category: i.category === "package" ? "profile" : i.category, qty: i.qty, rate: rupees(i.ratePaise),
      discountAmount: i.discountPaise ? rupees(i.discountPaise) : undefined, taxPercent: i.taxPercent || undefined, hsn: i.hsnSac,
    }));
    const notes = [invoice.status === "cancelled" ? `CANCELLED: ${invoice.cancelReason ?? ""}`.trim() : "", refunded ? `Refunded Rs. ${rupees(refunded).toFixed(2)}` : ""].filter(Boolean);
    return {
      invoiceNo: invoice.invoiceNo,
      date: at,
      patient: printPatient(patient, at),
      items,
      discount: billDiscount > 0 ? { amount: rupees(billDiscount) } : undefined,
      payments: payments.filter((p) => p.kind === "payment").map((p) => ({ mode: MODE_LABEL[p.mode], amount: rupees(p.amountPaise), date: p.receivedAt, reference: p.reference })),
      notes: notes.length ? notes : undefined,
      roundOff: true,
    };
  }

  async renderStoredInvoice(actor: Actor, invoice: DbInvoice, o: RenderOptions) {
    const printed = await this.storedInvoice(actor, invoice);
    // the printed total must equal the stored one (both are integer-paise maths with the same rules)
    const t = computeInvoice(printed);
    if (Math.round(t.total * 100) !== invoice.totalPaise) throw new ConflictError(`Invoice ${invoice.invoiceNo}: printed total ${t.total} differs from the stored total`);
    return this.renderInvoice(printed, { ...o, fileName: o.fileName ?? `${invoice.invoiceNo.replaceAll("/", "-")}.${o.format}` });
  }

  /**
   * A booking's reports as one printed report. Only verified or released reports print. A report
   * whose test code is a report-kit template uses that template (results keyed by its field keys);
   * any other test prints as a standard Test | Result | Unit | Range table.
   */
  async renderBookingReports(actor: Actor, bookingId: Id, reportIds: Id[] | null, o: RenderOptions) {
    const booking = mustOwn(await this.repos.bookings.get(bookingId), actor.orgId, "Booking", bookingId);
    let reports = await this.repos.reports.find({ bookingId });
    if (reportIds?.length) reports = reports.filter((r) => reportIds.includes(r.id));
    if (!reports.length) throw new NotFoundError("Report", reportIds?.join(",") ?? bookingId);
    const unready = reports.find((r) => r.status !== "verified" && r.status !== "released");
    if (unready) throw new ConflictError(`Report ${unready.testName} is ${unready.status}; verify it before printing`);
    const patient = mustOwn(await this.repos.patients.get(booking.patientId), actor.orgId, "Patient", booking.patientId);
    const doctor = booking.doctorId ? await this.repos.doctors.get(booking.doctorId) : null;
    const samples = await this.repos.samples.find({ bookingId });
    const collected = samples.map((s) => s.collectedAt).filter(Boolean).sort()[0] ?? booking.createdAt;
    const reportedAt = reports.map((r) => r.verifiedAt ?? r.updatedAt).filter(Boolean).sort().at(-1) ?? new Date();
    const printed = printPatient(patient, reportedAt, {
      refDoctor: doctor?.name ?? "Self", sampleId: booking.bookingNo, sampleCollectionDate: collected, collectedAt: collected, registeredAt: booking.createdAt, reportedAt,
    });
    const report: PrintReport = { patient: printed, sections: reports.flatMap((r) => this.sections(r, printed)) };
    return this.renderReport(report, { ...o, fileName: o.fileName ?? `${booking.bookingNo}-${o.variant}.${o.format}` });
  }

  private sections(r: DbReport, patient: PrintPatient): Section[] {
    const template = (TEMPLATES as Record<string, (typeof TEMPLATES)[keyof typeof TEMPLATES]>)[r.testCode.toLowerCase()];
    const flag = (f: string | undefined): TestRow["flag"] => (f === "H" ? "high" : f === "L" ? "low" : f === "A" ? "abnormal" : f === "" ? "normal" : "auto");
    if (template) {
      // results match a template row by its key ("hb") or its label ("Haemoglobin (HB)"), ignoring case and punctuation
      const norm = (x: string) => x.toLowerCase().replace(/[^a-z0-9]/g, "");
      const keyOf = new Map<string, string>();
      for (const f of template.fields) {
        keyOf.set(norm(f.key), f.key);
        keyOf.set(norm(f.label), f.key);
      }
      const matched = r.results.flatMap((x) => {
        const key = keyOf.get(norm(x.parameter));
        return key ? [[key, { value: x.value, flag: flag(x.flag), unit: x.unit, range: x.range }] as const] : [];
      });
      if (matched.length === r.results.length && matched.length) return buildReport(patient, [{ template: template.id as never, results: Object.fromEntries(matched) }]).sections;
    }
    const cat = getTestByCode(r.testCode);
    return [{
      title: (cat?.department ?? "LABORATORY").toUpperCase(),
      subtitle: r.testName,
      specimen: cat?.sampleType ?? undefined,
      columns: COLS_STD,
      rows: r.results.map((x): TestRow => ({ kind: "test", name: x.parameter, result: x.value, unit: x.unit, range: x.range, flag: flag(x.flag) })),
    }];
  }

  // ---------------------------------------------------------------- rendering

  private async renderReport(report: PrintReport, o: RenderOptions): Promise<RenderedDocument> {
    const name = o.fileName ?? `${report.patient.patientId ?? "report"}-${o.variant}.${o.format}`;
    if (o.format === "html") return htmlDoc(name, await renderReportHtml({ report, variant: o.variant, design: o.design, lab: this.lab, inline: true }));
    return pdfDoc(name, await renderReportPdf({ report, variant: o.variant, design: o.design, lab: this.lab }));
  }

  private async renderInvoice(invoice: PrintInvoice, o: RenderOptions): Promise<RenderedDocument> {
    const name = o.fileName ?? `${invoice.invoiceNo.replaceAll("/", "-")}.${o.format}`;
    if (o.format === "html") return htmlDoc(name, await renderInvoiceHtml({ invoice, variant: o.variant, lab: this.lab, inline: true }));
    return pdfDoc(name, await renderInvoicePdf({ invoice, variant: o.variant, lab: this.lab }));
  }
}

function pdfDoc(fileName: string, pdf: Buffer): RenderedDocument {
  return { format: "pdf", fileName, mimeType: "application/pdf", byteLength: pdf.byteLength, base64: pdf.toString("base64"), html: null };
}

function htmlDoc(fileName: string, html: string): RenderedDocument {
  return { format: "html", fileName, mimeType: "text/html; charset=utf-8", byteLength: Buffer.byteLength(html), base64: null, html };
}

export const assertFormat = (f: string): DocumentFormat => {
  if (f !== "pdf" && f !== "html") throw new ValidationError(`format must be pdf or html`);
  return f;
};
