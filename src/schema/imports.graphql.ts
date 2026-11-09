/**
 * Partner-lab report imports (docs/18-imports.md): a partner lab's PDF is read by report-reader, matched to
 * one of our bookings, and applied to our reports as entered results with their provenance. Our staff
 * verify and release them as usual; an import never does.
 */
export const importsTypeDefs = /* GraphQL */ `
  enum ExternalLab { hypatho clinova }
  enum ExternalReportStatus { extracted matched applied rejected }
  enum ExternalSignatoryRole { pathologist biochemist microbiologist consultant manager unknown }
  "How a signatory on a partner PDF was named: printed beside the signature, from our registry, or not at all."
  enum ExternalSignatorySource { text registry unknown }

  "A signature image from a partner PDF, PNG base64. Only ever served with that PDF's own results."
  type SignatureImage {
    mimeType: String!
    width: Int!
    height: Int!
    base64: String!
  }

  type ExternalParameter {
    name: String!
    "As printed."
    value: String!
    unit: String
    "As printed (the partner's range for the partner's method; never recomputed)."
    range: String
    method: String
    flag: ResultFlag
    group: String
  }

  "Who performed a test and who reported it, as it will print under the test."
  type ExternalProvenanceLabel {
    performedBy: String!
    performedAt: String
    "Only when the partner marked this test accredited: the partner's accreditation, not ours."
    accreditationText: String
    "Medical signatories only."
    reportedBy: [ExternalReportedBy!]!
    "The whole line."
    text: String!
  }

  type ExternalReportedBy { id: String!, name: String, qualification: String, registration: String, title: String, role: ExternalSignatoryRole! }

  type ExternalTest {
    "Position in the partner report (use it in ExternalTestMappingInput)."
    index: Int!
    name: String!
    department: String
    sampleType: String
    sampleId: String
    reported: String
    method: String
    "True only when the partner marked this test as accredited."
    accredited: Boolean!
    parameters: [ExternalParameter!]!
    notes: String
    "Ids of the signatories who signed this test's pages."
    signedBy: [String!]!
    "Our catalog test suggested for it (top search hit), for staff to confirm."
    suggestedTestCode: String
    provenance: ExternalProvenanceLabel!
  }

  type ExternalSignatoryOnReport {
    id: String!
    "Null until someone names this signature (nameExternalSignature)."
    name: String
    qualification: String
    registration: String
    title: String
    role: ExternalSignatoryRole!
    "Only medical signatories appear in Reported by."
    medical: Boolean!
    source: ExternalSignatorySource!
    "SHA-256 of the signature image (pass it to nameExternalSignature)."
    sha: String!
    pages: [Int!]!
    "The signature image from this PDF."
    image: SignatureImage
  }

  type ExternalPatient { name: String, title: String, ageText: String, ageYears: Int, sex: Sex, patientId: String }

  type ExternalReport {
    id: ID!
    branchId: ID!
    booking: Booking
    lab: ExternalLab!
    labName: String!
    processedAt: String
    status: ExternalReportStatus!
    fileName: String
    byteLength: Int!
    "SHA-256 of the PDF."
    sourceSha256: String!
    "Reader warnings and booking-check differences."
    warnings: [String!]!
    "Differences from the booking's patient (name, sex, age ±1). Applying needs confirmPatientMismatch when there are any."
    patientMismatches: [String!]!
    patient: ExternalPatient!
    sampleIds: [String!]!
    reportedAt: String
    tests: [ExternalTest!]!
    signatories: [ExternalSignatoryOnReport!]!
    "Our reports it was applied to."
    reports: [Report!]!
    uploadedBy: User
    uploadedAt: DateTime!
    appliedAt: DateTime
    rejectReason: String
  }

  type PageInfo { hasNextPage: Boolean!, endCursor: String }
  type ExternalReportConnection { nodes: [ExternalReport!]!, pageInfo: PageInfo! }

  "A partner signatory in the organisation's registry (data entered by staff, never code)."
  type ExternalSignatory {
    id: ID!
    lab: ExternalLab!
    name: String!
    qualification: String
    registration: String
    title: String
    role: ExternalSignatoryRole
    "How many signature images are tied to this person."
    signatureCount: Int!
    createdAt: DateTime!
  }

  "Where one of our reports came from, when its results were imported from a partner PDF."
  type ReportProvenance {
    externalReportId: ID!
    lab: ExternalLab!
    performedBy: String!
    performedAt: String
    accreditationText: String
    reportedBy: [ExternalReportedBy!]!
    sourceTestName: String!
    sourceSampleId: String
    sourceReportedAt: String
    "The results as imported (for comparison when staff edit them)."
    importedResults: [ResultValue!]!
    appliedAt: DateTime!
  }

  extend type Report {
    "Set when the results came from a partner lab's report."
    provenance: ReportProvenance
  }

  input ExternalTestMappingInput {
    "ExternalTest.index"
    testIndex: Int!
    "One of the booking's test codes."
    testCode: String!
    "false skips the test."
    include: Boolean = true
  }

  input ExternalSignatoryInput {
    "ExternalSignatoryOnReport.sha"
    sha: String!
    lab: ExternalLab!
    name: String!
    qualification: String
    registration: String
    title: String
    role: ExternalSignatoryRole
  }

  extend type Query {
    externalReport(id: ID!): ExternalReport
    externalReports(branchId: ID, bookingId: ID, status: ExternalReportStatus, first: Int = 50, after: String): ExternalReportConnection!
    "The organisation's partner signatory registry."
    externalSignatories(lab: ExternalLab): [ExternalSignatory!]!
  }

  extend type Mutation {
    """
    Reads a partner lab's PDF (base64, up to IMPORT_MAX_BYTES). The same PDF again returns the same import.
    branchId defaults to the booking's branch.
    """
    importExternalReport(pdfBase64: String!, fileName: String, bookingId: ID, branchId: ID): ExternalReport!
    "Ties an import to a booking; patient differences become warnings."
    matchExternalReport(id: ID!, bookingId: ID!): ExternalReport!
    "Writes the mapped tests into our reports as entered results with provenance. Staff verify as usual."
    applyExternalReport(id: ID!, mappings: [ExternalTestMappingInput!]!, confirmPatientMismatch: Boolean = false): [Report!]!
    rejectExternalReport(id: ID!, reason: String!): ExternalReport!
    "Names a partner signature; the organisation's unapplied imports that carry it are read again."
    nameExternalSignature(input: ExternalSignatoryInput!): ExternalSignatory!
  }
`;
