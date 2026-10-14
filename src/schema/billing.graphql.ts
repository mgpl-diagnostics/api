/** Patient invoices and payments. Issuing and paying post to the books automatically. */
export const billingTypeDefs = /* GraphQL */ `
  enum InvoiceStatus { draft issued partially_paid paid cancelled refunded credited }
  enum PaymentKind { payment refund }

  type InvoiceItem {
    code: String
    name: String!
    category: ItemCategory!
    qty: Float!
    ratePaise: Int!
    discountPaise: Int!
    taxPercent: Float!
    hsnSac: String
    taxability: Taxability
    amountPaise: Int!
  }

  type Invoice {
    id: ID!
    invoiceNo: String!
    status: InvoiceStatus!
    patient: Patient!
    branch: Branch!
    booking: Booking
    customer: Customer
    placeOfSupply: String
    buyerGstin: String
    items: [InvoiceItem!]!
    subtotalPaise: Int!
    discountPaise: Int!
    taxPaise: Int!
    roundOffPaise: Int!
    totalPaise: Int!
    paidPaise: Int!
    creditedPaise: Int!
    duePaise: Int!
    issuedAt: DateTime
    cancelReason: String
    createdAt: DateTime!
    payments: [Payment!]!
    vouchers: [Voucher!]!
    creditNotes: [CreditNote!]!
  }

  type Payment { id: ID!, kind: PaymentKind!, amountPaise: Int!, mode: PaymentMode!, reference: String, receivedAt: DateTime! }

  extend type Query {
    invoice(id: ID!): Invoice
    invoices(branchId: ID, status: InvoiceStatus, patientId: ID, customerId: ID, limit: Int = 50, offset: Int = 0): [Invoice!]!
  }

  "A catalog-kit test code alone is enough: name and MRP come from the catalog."
  input InvoiceItemInput { code: String, name: String, category: ItemCategory = test, qty: Float = 1, ratePaise: Int, discountPaise: Int = 0, taxPercent: Float = 0, hsnSac: String, taxability: Taxability }
  input PaymentInput { amountPaise: Int!, mode: PaymentMode!, reference: String }

  input IssueInvoiceInput {
    branchId: ID!
    patientId: ID!
    bookingId: ID
    items: [InvoiceItemInput!]!
    billDiscountPaise: Int = 0
    "Taken at the counter with the invoice."
    payments: [PaymentInput!]
    "Fill HSN/SAC, taxability and GST rate from the tax rules."
    applyTaxRules: Boolean = false
  }

  extend type Mutation {
    issueInvoice(input: IssueInvoiceInput!): Invoice!
    recordPayment(invoiceId: ID!, payment: PaymentInput!): Invoice!
    refundPayment(invoiceId: ID!, payment: PaymentInput!): Invoice!
    cancelInvoice(id: ID!, reason: String!): Invoice!
  }
`;
