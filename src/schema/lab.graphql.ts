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
    invoice: Invoice
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

  type CreateBookingResult { booking: Booking!, samples: [Sample!]! }

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
  }

  "Unit, range and flag are filled from catalog-kit when omitted and the test is in the catalog."
  input ResultInput { parameter: String!, value: String!, unit: String, flag: ResultFlag, range: String }

  extend type Mutation {
    registerPatient(input: RegisterPatientInput!): Patient!
    updatePatient(id: ID!, input: UpdatePatientInput!): Patient!
    createDoctor(input: DoctorInput!): Doctor!
    updateDoctor(id: ID!, input: DoctorPatch!): Doctor!

    createBooking(input: CreateBookingInput!): CreateBookingResult!
    cancelBooking(id: ID!): Booking!
    collectSample(id: ID!): Sample!
    receiveSample(id: ID!): Sample!
    rejectSample(id: ID!, reason: String!): Sample!

    createReport(bookingId: ID!, testCode: String!, testName: String): Report!
    saveResults(reportId: ID!, results: [ResultInput!]!): Report!
    verifyReport(id: ID!): Report!
    releaseReport(id: ID!): Report!
    amendReport(id: ID!): Report!
  }
`;
