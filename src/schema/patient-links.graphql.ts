/**
 * Patient links (docs/19-patient-links.md): the QR printed on a booking's reports and bills opens a public,
 * read-only page with that booking's bill and released reports. The token in the link is the only key;
 * unknown, expired, revoked and malformed tokens all answer null. Every patient call is rate-limited per IP.
 */
export const patientLinksTypeDefs = /* GraphQL */ `
  "A booking's patient link, for staff to send or show."
  type PatientLinkInfo {
    url: String!
    expiresAt: DateTime!
  }

  type PatientPageBranch {
    name: String!
    phone: String
    address: String
  }

  type PatientPageInvoice {
    id: ID!
    invoiceNo: String!
    issuedAt: DateTime!
    totalPaise: Int!
    paidPaise: Int!
    duePaise: Int!
    status: String!
  }

  type PatientPageReport {
    id: ID!
    testName: String!
    releasedAt: DateTime
  }

  "What a patient sees from their link: one booking, nothing else. The name is shortened (\\"Ravi K. S.\\")."
  type PatientPage {
    labName: String!
    patientName: String!
    bookingNo: String!
    bookedAt: DateTime!
    branch: PatientPageBranch!
    "Issued bills of the booking (drafts and cancelled bills are left out)."
    invoices: [PatientPageInvoice!]!
    "Released reports (verified ones are not given out yet)."
    reports: [PatientPageReport!]!
    "Tests still in the lab, by name."
    pending: [String!]!
    expiresAt: DateTime!
  }

  enum PatientDocumentKind { invoice reports }

  extend type Query {
    "Public (no sign-in): the page behind a patient link, or null."
    patientPage(token: String!): PatientPage
    "Public (no sign-in): a PDF from a patient link: one of its bills (invoiceId) or its released reports. Null when the link does not open."
    patientDocument(token: String!, kind: PatientDocumentKind!, invoiceId: ID): Document
    "The booking's patient link (made on first use). Needs booking:read and report:read on the booking's branch."
    patientLink(bookingId: ID!): PatientLinkInfo!
  }

  extend type Mutation {
    "Stops every link of the booking (printed QRs stop opening); the next print makes a new one. Returns how many were stopped. Needs booking:update."
    revokePatientLinks(bookingId: ID!): Int!
  }
`;
