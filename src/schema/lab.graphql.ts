/** Patients, doctors, bookings, samples and reports (db-kit workflows). */
export const labTypeDefs = /* GraphQL */ `
  enum BookingStatus { booked sample_collected in_process completed cancelled }
  enum CollectionType { walk_in home }
  enum SampleStatus { pending collected received rejected }
  enum ReportStatus { draft entered verified released amended }
  enum ResultFlag { L H A NONE }

  type Patient {
    id: ID!
    uhid: String!
    title: String
    name: String!
    sex: Sex!
    dob: DateTime
    ageYears: Int
    phone: String
    email: String
    address: Address
    branch: Branch
    createdAt: DateTime!
    bookings(limit: Int = 20): [Booking!]!
    invoices(limit: Int = 20): [Invoice!]!
  }

  type Doctor { id: ID!, name: String!, qualification: String, phone: String, clinic: String, active: Boolean! }

  type BookingTest { testCode: String!, name: String!, pricePaise: Int!, sampleType: String, "The catalog entry, when the code is in catalog-kit." catalog: CatalogTest }
  type SampleCollection { type: CollectionType!, scheduledAt: DateTime, address: Address }

  type Booking {
    id: ID!
    bookingNo: String!
    status: BookingStatus!
    patient: Patient!
    doctor: Doctor
    branch: Branch!
    tests: [BookingTest!]!
    sampleCollection: SampleCollection!
    samples: [Sample!]!
    reports: [Report!]!
    "The booking's current invoice (the first one that is not cancelled)."
    invoice: Invoice
    "Every invoice issued for the booking, oldest first: its first one, replacements, and invoices for tests added after it was paid."
    invoices: [Invoice!]!
    notes: String
    createdAt: DateTime!
  }

  type Sample {
    id: ID!
    barcode: String!
    sampleType: String!
    status: SampleStatus!
    collectedAt: DateTime
    receivedAt: DateTime
    rejectReason: String
    booking: Booking!
  }

  type ResultValue { parameter: String!, value: String!, unit: String, flag: ResultFlag, range: String }

  type Report {
    id: ID!
    testCode: String!
    testName: String!
    status: ReportStatus!
    results: [ResultValue!]!
    version: Int!
    verifiedAt: DateTime
    releasedAt: DateTime
    patient: Patient!
    booking: Booking!
    updatedAt: DateTime!
  }

  type CreateBookingResult {
    booking: Booking!
    samples: [Sample!]!
    "Issued with the booking when input.bill is given."
    invoice: Invoice
  }

  type UpdateBookingResult {
    booking: Booking!
    samples: [Sample!]!
    "Invoices issued by the change: a replacement for an unpaid invoice, or one for tests added after payment."
    issuedInvoices: [Invoice!]!
    "Unpaid invoices cancelled by the change (replaced, or no longer needed)."
    cancelledInvoices: [Invoice!]!
    "Credit notes for removed tests on invoices that were paid or already credited."
    creditNotes: [CreditNote!]!
    "Money paid that can now be refunded (refundPayment on the invoice)."
    refundablePaise: Int!
  }

  extend type Query {
    patient(id: ID!): Patient
    "Name, phone or UHID."
    patients(search: String!, limit: Int = 20): [Patient!]!
    doctors(activeOnly: Boolean = true): [Doctor!]!
    booking(id: ID!): Booking
    bookings(branchId: ID, status: BookingStatus, patientId: ID, limit: Int = 50, offset: Int = 0): [Booking!]!
    sample(id: ID!): Sample
    sampleByBarcode(barcode: String!): Sample
    report(id: ID!): Report
  }

  input RegisterPatientInput { branchId: ID!, title: String, name: String!, sex: Sex!, dob: DateTime, ageYears: Int, phone: String, email: String, address: AddressInput }
  input UpdatePatientInput { title: String, name: String, sex: Sex, dob: DateTime, ageYears: Int, phone: String, email: String, address: AddressInput }
  input DoctorInput { name: String!, qualification: String, phone: String, clinic: String, active: Boolean = true }
  input DoctorPatch { name: String, qualification: String, phone: String, clinic: String, active: Boolean }

  "A test by catalog code: name, price and sample type come from catalog-kit unless given."
  input BookingTestInput { testCode: String!, name: String, pricePaise: Int, sampleType: String }

  input CreateBookingInput {
    branchId: ID!
    patientId: ID!
    doctorId: ID
    tests: [BookingTestInput!]!
    collectionType: CollectionType = walk_in
    scheduledAt: DateTime
    notes: String
    "Bill at once: an invoice for the booked tests, in the same transaction (needs invoice:create; a discount needs invoice:discount, payments payment:create)."
    bill: BookingBillInput
  }

  input BookingBillInput {
    billDiscountPaise: Int = 0
    "Taken at the counter with the booking."
    payments: [PaymentInput!]
    "Fill HSN/SAC, taxability and GST rate from the tax rules."
    applyTaxRules: Boolean = false
  }

  """
  Changes to a booking; fields left out stay as they are. doctorId: null removes the doctor, scheduledAt: null
  and collectionAddress: null clear them. Tests can be removed only while they have no results.
  """
  input UpdateBookingInput {
    doctorId: ID
    collectionType: CollectionType
    scheduledAt: DateTime
    collectionAddress: AddressInput
    notes: String
    addTests: [BookingTestInput!]
    removeTestCodes: [String!]
  }

  "Unit, range and flag are filled from catalog-kit when omitted and the test is in the catalog."
  input ResultInput { parameter: String!, value: String!, unit: String, flag: ResultFlag, range: String }

  extend type Mutation {
    registerPatient(input: RegisterPatientInput!): Patient!
    updatePatient(id: ID!, input: UpdatePatientInput!): Patient!
    createDoctor(input: DoctorInput!): Doctor!
    updateDoctor(id: ID!, input: DoctorPatch!): Doctor!

    createBooking(input: CreateBookingInput!): CreateBookingResult!
    """
    Edits a booking (booking:update): doctor, collection details, notes, tests. Samples follow the tests. Billing
    follows too: an unpaid invoice is cancelled and issued again (invoice:cancel when tests are removed,
    invoice:create), a paid one gets a credit note for removed tests (accounts:post) and an invoice for added ones
    (invoice:create). One transaction, audited as booking.update.
    """
    updateBooking(id: ID!, input: UpdateBookingInput!): UpdateBookingResult!
    cancelBooking(id: ID!): Booking!
    "Marks the sample collected. barcode: the tube's own label, when it is not the generated one (unique in the organisation)."
    collectSample(id: ID!, barcode: String): Sample!
    "A new barcode for a sample that the lab has not received yet (BARCODE_TAKEN when another sample has it)."
    relabelSample(id: ID!, barcode: String!): Sample!
    receiveSample(id: ID!): Sample!
    rejectSample(id: ID!, reason: String!): Sample!

    createReport(bookingId: ID!, testCode: String!, testName: String): Report!
    saveResults(reportId: ID!, results: [ResultInput!]!): Report!
    verifyReport(id: ID!): Report!
    releaseReport(id: ID!): Report!
    amendReport(id: ID!): Report!
  }
`;
