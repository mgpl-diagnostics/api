/**
 * Documents rendered by report-kit (lab reports, letterhead) and invoice-kit (invoices), used as
 * internal libraries. PDFs come back base64-encoded in \`base64\`; HTML is self-contained in \`html\`.
 */
export const documentsTypeDefs = /* GraphQL */ `
  enum DocumentFormat { pdf html }
  enum ReportVariant { header non_header }
  enum ReportDesign { sidebar classic }

  type Document {
    format: DocumentFormat!
    fileName: String!
    mimeType: String!
    byteLength: Int!
    "PDF bytes, base64 (null for HTML)."
    base64: String
    "Self-contained HTML (null for PDF)."
    html: String
  }

  type TemplateField { key: String!, label: String!, unit: String, range: [String!] }
  type ReportTemplate { id: String!, name: String!, category: String, specimen: String, method: String, fields: [TemplateField!]! }
  type ReportProfile { id: String!, name: String!, tests: [String!]! }
  type TemplateCatalog { templates: [ReportTemplate!]!, profiles: [ReportProfile!]! }
  type PriceListEntry { code: String!, name: String!, category: String!, "rupees" rate: Float!, taxPercent: Float, hsn: String }
  type DocumentSample { id: String!, label: String!, group: String }

  enum JobState { waiting active completed failed delayed }
  enum DocumentJobKind { invoice booking_reports }

  "Background work run by the worker (BullMQ on Redis), or in the API process when there is no Redis."
  type Job {
    id: ID!
    kind: DocumentJobKind!
    state: JobState!
    "Tries so far (failed jobs are retried with back-off)."
    attempts: Int!
    "Why it failed (state failed)."
    error: String
    "The rendered document (state completed). Kept for an hour by default."
    document: Document
    createdAt: DateTime!
    finishedAt: DateTime
  }

  input DocumentJobInput {
    kind: DocumentJobKind!
    "kind invoice"
    invoiceId: ID
    "kind booking_reports"
    bookingId: ID
    "kind booking_reports: only these reports (default: every verified or released one)"
    reportIds: [ID!]
    format: DocumentFormat = pdf
    variant: ReportVariant = header
    design: ReportDesign = sidebar
  }

  extend type Query {
    "A job you started (null when unknown, expired, or someone else's)."
    job(id: ID!): Job
    reportTemplates: TemplateCatalog!
    "invoice-kit's sample price list (codes = report-kit template and profile ids, services, consumables)."
    priceList: [PriceListEntry!]!
    "Demo samples (empty unless the server enables them)."
    documentSamples: [DocumentSample!]!
    invoiceSamples: [DocumentSample!]!

    "Any report: request = report-kit's ReportRequest JSON (patient + tests | profile | report | sample)."
    renderReport(request: JSON!, format: DocumentFormat = pdf, variant: ReportVariant = header, design: ReportDesign = sidebar, fileName: String): Document!
    "Any invoice: request = invoice-kit's InvoiceRequest JSON ({ invoice } or { sample })."
    renderInvoice(request: JSON!, format: DocumentFormat = pdf, variant: ReportVariant = header, fileName: String): Document!
    "invoice-kit's calculation of an InvoiceRequest, without rendering (rupees)."
    invoiceTotals(request: JSON!): JSON!
    letterhead(format: DocumentFormat = pdf): Document!

    "A stored invoice, printed."
    invoiceDocument(invoiceId: ID!, format: DocumentFormat = pdf, variant: ReportVariant = header): Document!
    "A booking's verified or released reports, printed together (or only reportIds)."
    bookingReportDocument(bookingId: ID!, reportIds: [ID!], format: DocumentFormat = pdf, variant: ReportVariant = header, design: ReportDesign = sidebar): Document!
  }

  extend type Mutation {
    "Renders a stored invoice or a booking's reports in the background; poll job(id) until completed or failed."
    startDocumentJob(input: DocumentJobInput!): Job!
  }
`;
