/**
 * finance-kit: GST, B2B receivables and credit notes, collection-centre settlements with TDS, day-end
 * cash, bank reconciliation, lock dates, year-end close, CSV exports. Compliance values are
 * configuration to be verified with the lab's CA (see verifyWithCA); nothing here is legal advice.
 */
export const financeTypeDefs = /* GraphQL */ `
  # ---------------------------------------------------------------- GST
  type TaxRule { id: ID!, code: String, category: ItemCategory, hsnSac: String!, taxability: Taxability!, ratePercent: Float!, effectiveFrom: DateTime!, effectiveTo: DateTime, note: String }

  type TdsConfig { section: String!, rateBp: Int!, noPanRateBp: Int!, thresholdPaise: Int }
  type FinanceConfig { b2clThresholdPaise: Int!, tds: TdsConfig!, bankToleranceDays: Int!, bankMaxFeeBp: Int!, clearingLedgerKeys: [String!]! }

  type RateTotals { ratePercent: Float!, taxablePaise: Int!, igstPaise: Int!, cgstPaise: Int!, sgstPaise: Int!, cessPaise: Int! }
  type TaxTotals { taxablePaise: Int!, igstPaise: Int!, cgstPaise: Int!, sgstPaise: Int!, cessPaise: Int! }
  type Gstr1Invoice { invoiceId: ID!, invoiceNo: String!, day: Day!, valuePaise: Int!, placeOfSupply: String!, reverseCharge: String!, ctin: String, items: [RateTotals!]! }
  type Gstr1Note { noteId: ID!, noteNo: String!, day: Day!, noteType: String!, invoiceNo: String!, invoiceDay: Day!, valuePaise: Int!, placeOfSupply: String!, ctin: String, type: String, items: [RateTotals!]! }
  type B2csRow { supplyType: String!, placeOfSupply: String!, ratePercent: Float!, taxablePaise: Int!, igstPaise: Int!, cgstPaise: Int!, sgstPaise: Int!, cessPaise: Int! }
  type NilRow { description: String!, nilRatedPaise: Int!, exemptedPaise: Int!, nonGstPaise: Int! }
  type HsnRow { hsnSac: String!, ratePercent: Float!, taxability: Taxability!, qty: Float!, taxablePaise: Int!, igstPaise: Int!, cgstPaise: Int!, sgstPaise: Int!, cessPaise: Int!, totalValuePaise: Int! }
  type HsnSummary { b2b: [HsnRow!]!, b2c: [HsnRow!]! }
  type DocSeries { nature: String!, series: String!, from: String!, to: String!, total: Int!, cancelled: Int!, net: Int! }
  type Period { from: DateTime!, to: DateTime! }

  type Gstr1 {
    gstin: String!
    period: Period!
    b2b: [Gstr1Invoice!]!
    b2cl: [Gstr1Invoice!]!
    b2cs: [B2csRow!]!
    cdnr: [Gstr1Note!]!
    cdnur: [Gstr1Note!]!
    nil: [NilRow!]!
    hsn: HsnSummary!
    docs: [DocSeries!]!
    totals: TaxTotals!
    verifyWithCA: [String!]!
  }

  type InterStateRow { placeOfSupply: String!, taxablePaise: Int!, igstPaise: Int! }
  type Gstr3b {
    gstin: String!
    period: Period!
    "3.1(a)"
    outwardTaxable: TaxTotals!
    "3.1(c)"
    outwardNilExemptPaise: Int!
    "3.1(e)"
    outwardNonGstPaise: Int!
    "3.2"
    interStateUnregistered: [InterStateRow!]!
    verifyWithCA: [String!]!
  }

  # ---------------------------------------------------------------- receivables
  enum CustomerKind { hospital insurer tpa corporate other }
  enum OpenItemBucket { not_due D1_30 D31_60 D61_90 D90_PLUS }

  type Customer {
    id: ID!
    code: String!
    name: String!
    kind: CustomerKind!
    legalName: String
    gstin: String
    stateCode: String
    pan: String
    phone: String
    email: String
    address: Address
    "null = no limit."
    creditLimitPaise: Int
    creditDays: Int!
    ledger: Ledger!
    active: Boolean!
  }

  type OpenItem { invoiceId: ID!, invoiceNo: String!, day: Day!, dueDay: Day!, totalPaise: Int!, paidPaise: Int!, creditedPaise: Int!, duePaise: Int!, overdueDays: Int!, bucket: OpenItemBucket! }
  type Ageing { notDue: Int!, d1to30: Int!, d31to60: Int!, d61to90: Int!, d90plus: Int! }
  type CustomerStatement {
    customer: Customer!
    openingPaise: Int!
    rows: [StatementRow!]!
    totalDebitPaise: Int!
    totalCreditPaise: Int!
    closingPaise: Int!
    open: [OpenItem!]!
    ageing: Ageing!
    openTotalPaise: Int!
    availableCreditPaise: Int
  }
  type ReceivablesRow { customer: Customer!, balancePaise: Int!, overduePaise: Int!, ageing: Ageing! }
  type ReceivablesSummary { rows: [ReceivablesRow!]!, totalPaise: Int! }

  type CreditNoteLine { itemIndex: Int!, name: String!, code: String, hsnSac: String, taxability: Taxability, taxPercent: Float!, taxablePaise: Int!, taxPaise: Int!, cgstPaise: Int!, sgstPaise: Int!, igstPaise: Int! }
  type CreditNote {
    id: ID!
    noteNo: String!
    date: DateTime!
    reason: String!
    invoice: Invoice!
    customer: Customer
    lines: [CreditNoteLine!]!
    taxablePaise: Int!
    taxPaise: Int!
    cgstPaise: Int!
    sgstPaise: Int!
    igstPaise: Int!
    roundOffPaise: Int!
    totalPaise: Int!
    placeOfSupply: String
    buyerGstin: String
    status: String!
  }
  type CreditNoteResult { creditNote: CreditNote!, invoice: Invoice!, "Refund with refundPayment." refundablePaise: Int! }

  # ---------------------------------------------------------------- settlements
  enum PartnerKind { collection_centre franchise }
  enum AgreementKind { revenue_share fixed_rate }
  enum SettlementStatus { draft accrued paid cancelled }

  type PartnerTds { section: String!, rateBp: Int! }
  type Partner {
    id: ID!
    code: String!
    name: String!
    kind: PartnerKind!
    branch: Branch!
    legalName: String
    pan: String
    gstin: String
    stateCode: String
    phone: String
    email: String
    address: Address
    ledger: Ledger!
    "Overrides the default TDS (verify with CA)."
    tds: PartnerTds
    active: Boolean!
    agreements: [PartnerAgreement!]!
  }

  type ShareRate { code: String!, sharePaise: Int! }
  type PartnerAgreement { id: ID!, kind: AgreementKind!, shareBp: Int, rates: [ShareRate!], defaultSharePaise: Int, categories: [ItemCategory!], effectiveFrom: DateTime!, effectiveTo: DateTime, notes: String }

  type SettlementLine { invoiceId: ID!, invoiceNo: String!, day: Day!, code: String, name: String!, netPaise: Int!, sharePaise: Int!, agreementId: ID!, creditNoteId: ID }
  type SettlementDeduction { label: String!, amountPaise: Int!, ledgerId: ID }
  type Tds { section: String, rateBp: Int!, basePaise: Int!, tdsPaise: Int! }

  "A settlement computed but not saved."
  type SettlementPreview {
    partner: Partner!
    period: String!
    from: DateTime!
    to: DateTime!
    lines: [SettlementLine!]!
    grossPaise: Int!
    sharePaise: Int!
    deductions: [SettlementDeduction!]!
    deductionsPaise: Int!
    tds: Tds!
    netPaise: Int!
    "Invoice numbers with no agreement in force on their date."
    uncoveredInvoices: [String!]!
  }

  type Settlement {
    id: ID!
    partner: Partner!
    branch: Branch!
    period: String!
    from: DateTime!
    to: DateTime!
    lines: [SettlementLine!]!
    grossPaise: Int!
    sharePaise: Int!
    deductions: [SettlementDeduction!]!
    deductionsPaise: Int!
    tdsSection: String
    tdsRateBp: Int!
    tdsBasePaise: Int!
    tdsPaise: Int!
    netPaise: Int!
    status: SettlementStatus!
    accrualVoucher: Voucher
    payoutVoucher: Voucher
    paidAt: DateTime
    createdAt: DateTime!
  }

  # ---------------------------------------------------------------- cash and bank
  enum BankLineStatus { unmatched matched ignored }

  type CashDenomination { valuePaise: Int!, count: Int! }
  type CashClosing { id: ID!, branch: Branch!, day: Day!, bookPaise: Int!, countedPaise: Int!, "counted − book; negative = short." differencePaise: Int!, denominations: [CashDenomination!], voucher: Voucher, notes: String, createdAt: DateTime! }

  type BankStatement { id: ID!, branch: Branch!, ledger: Ledger!, fileName: String, from: DateTime, to: DateTime, openingPaise: Int, closingPaise: Int, lineCount: Int!, createdAt: DateTime! }
  type BankSettlementMatch { ledgerId: ID!, day: Day!, grossPaise: Int!, feePaise: Int! }
  type BankLine { id: ID!, statementId: ID!, date: DateTime!, description: String!, reference: String, debitPaise: Int!, creditPaise: Int!, balancePaise: Int, status: BankLineStatus!, matchKind: String, voucherIds: [ID!]!, settlement: BankSettlementMatch, matchedAt: DateTime }
  type BankImportResult { statement: BankStatement!, added: Int!, skipped: Int! }
  type ReconcileResult { matched: Int!, settlements: Int!, unmatched: Int! }
  type LedgerEntryRow { id: ID!, voucherId: ID!, voucherType: VoucherType!, voucherNo: String!, date: DateTime!, debitPaise: Int!, creditPaise: Int!, invoiceId: ID }
  type ReconciledTotals { lines: Int!, amountPaise: Int! }
  type BankReconciliation {
    bookPaise: Int!
    bankPaise: Int
    paymentsNotPresentedPaise: Int!
    depositsNotCreditedPaise: Int!
    bankCreditsNotInBooksPaise: Int!
    bankDebitsNotInBooksPaise: Int!
    expectedBankPaise: Int!
    differencePaise: Int
    reconciled: ReconciledTotals!
    unmatchedLines: [BankLine!]!
    unreconciledEntries: [LedgerEntryRow!]!
  }

  # ---------------------------------------------------------------- periods
  type PeriodLock { id: ID!, scope: String!, branch: Branch, lockedUpTo: DateTime, reason: String, updatedAt: DateTime! }
  type YearEndResult { vouchers: [Voucher!]!, netProfitPaise: Int! }

  # ---------------------------------------------------------------- exports
  type CsvFile { fileName: String!, mimeType: String!, content: String! }

  extend type Query {
    taxRules: [TaxRule!]!
    financeConfig: FinanceConfig!
    "Items the lab's CA must confirm before these values are relied on."
    verifyWithCA: [String!]!
    gstr1(from: DateTime!, to: DateTime!, gstin: String): Gstr1!
    gstr3b(from: DateTime!, to: DateTime!, gstin: String): Gstr3b!

    customers(activeOnly: Boolean = true): [Customer!]!
    customer(id: ID!): Customer
    customerStatement(customerId: ID!, from: DateTime!, to: DateTime!): CustomerStatement!
    receivablesSummary(asOf: DateTime!): ReceivablesSummary!
    creditNote(id: ID!): CreditNote
    creditNotes(invoiceId: ID, customerId: ID, limit: Int = 50, offset: Int = 0): [CreditNote!]!

    partners(branchId: ID): [Partner!]!
    partner(id: ID!): Partner
    "Computes a month's settlement without saving it. period: YYYY-MM."
    settlementPreview(partnerId: ID!, period: String!, deductions: [SettlementDeductionInput!]): SettlementPreview!
    settlements(partnerId: ID, status: SettlementStatus, branchId: ID, limit: Int = 50, offset: Int = 0): [Settlement!]!
    settlement(id: ID!): Settlement

    cashClosings(branchId: ID!, limit: Int = 31, offset: Int = 0): [CashClosing!]!
    bankStatements(ledgerId: ID, limit: Int = 50, offset: Int = 0): [BankStatement!]!
    bankLines(ledgerId: ID, statementId: ID, status: BankLineStatus, limit: Int = 100, offset: Int = 0): [BankLine!]!
    bankReconciliation(ledgerId: ID!, asOf: DateTime!): BankReconciliation!

    lockDates: [PeriodLock!]!

    exportDayBook(from: DateTime!, to: DateTime!, branchId: ID, bom: Boolean = false): CsvFile!
    exportLedger(ledgerId: ID!, from: DateTime!, to: DateTime!, branchId: ID, bom: Boolean = false): CsvFile!
    exportTrialBalance(asOf: DateTime, branchId: ID, bom: Boolean = false): CsvFile!
    exportProfitAndLoss(from: DateTime!, to: DateTime!, branchId: ID, bom: Boolean = false): CsvFile!
    exportBalanceSheet(asOf: DateTime!, branchId: ID, bom: Boolean = false): CsvFile!
    exportSettlement(settlementId: ID!, bom: Boolean = false): CsvFile!
    "One file per section: b2b, b2cl, b2cs, cdnr, cdnur, nil, hsn, docs."
    exportGstr1(from: DateTime!, to: DateTime!, gstin: String, bom: Boolean = false): [CsvFile!]!
    exportGstr3b(from: DateTime!, to: DateTime!, gstin: String, bom: Boolean = false): CsvFile!
  }

  input TaxRuleInput { code: String, category: ItemCategory, hsnSac: String!, taxability: Taxability!, ratePercent: Float!, effectiveFrom: Day!, note: String }

  input CustomerInput { code: String!, name: String!, kind: CustomerKind!, legalName: String, gstin: String, stateCode: String, pan: String, phone: String, email: String, address: AddressInput, creditLimitPaise: Int, creditDays: Int }
  input CustomerPatch { name: String, kind: CustomerKind, legalName: String, gstin: String, stateCode: String, pan: String, phone: String, email: String, address: AddressInput, "null removes the limit." creditLimitPaise: Int, creditDays: Int, active: Boolean }
  input CustomerInvoiceInput {
    branchId: ID!
    patientId: ID!
    customerId: ID!
    bookingId: ID
    items: [InvoiceItemInput!]!
    billDiscountPaise: Int = 0
    payments: [PaymentInput!]
    "State code override."
    placeOfSupply: String
    applyTaxRules: Boolean = true
  }
  input CreditNoteLineInput { itemIndex: Int!, taxablePaise: Int }
  input CreditNoteInput { invoiceId: ID!, reason: String!, "Default: everything not yet credited." lines: [CreditNoteLineInput!], date: DateTime }

  input PartnerTdsInput { section: String!, rateBp: Int! }
  input PartnerInput { code: String!, name: String!, kind: PartnerKind!, branchId: ID!, legalName: String, pan: String, gstin: String, stateCode: String, phone: String, email: String, address: AddressInput, tds: PartnerTdsInput }
  input PartnerPatch { name: String, kind: PartnerKind, legalName: String, pan: String, gstin: String, stateCode: String, phone: String, email: String, address: AddressInput, "null = default TDS." tds: PartnerTdsInput, active: Boolean }
  input ShareRateInput { code: String!, sharePaise: Int! }
  input AgreementInput { partnerId: ID!, kind: AgreementKind!, shareBp: Int, rates: [ShareRateInput!], defaultSharePaise: Int, categories: [ItemCategory!], effectiveFrom: Day!, effectiveTo: Day, notes: String }
  input SettlementDeductionInput { label: String!, amountPaise: Int!, ledgerId: ID }
  input PaySettlementInput { settlementId: ID!, mode: PaymentMode!, date: DateTime, reference: String }

  input CashDenominationInput { valuePaise: Int!, count: Int! }
  input CloseCashDayInput { branchId: ID!, day: Day!, countedPaise: Int!, denominations: [CashDenominationInput!], notes: String }
  input BankImportInput { branchId: ID!, ledgerId: ID!, "The bank's CSV export, as text." csv: String!, fileName: String }
  enum BankLineManualStatus { ignored unmatched }

  input LockDateInput { "Omit for the whole organisation." branchId: ID, "Last locked IST day; null removes the lock." upTo: Day, reason: String }

  extend type Mutation {
    addTaxRule(input: TaxRuleInput!): TaxRule!
    "finance-kit's starting rules. Every rate must be verified with the lab's CA."
    seedTaxRules: [TaxRule!]!

    createCustomer(input: CustomerInput!): Customer!
    updateCustomer(id: ID!, input: CustomerPatch!): Customer!
    issueCustomerInvoice(input: CustomerInvoiceInput!): Invoice!
    issueCreditNote(input: CreditNoteInput!): CreditNoteResult!

    createPartner(input: PartnerInput!): Partner!
    updatePartner(id: ID!, input: PartnerPatch!): Partner!
    addAgreement(input: AgreementInput!): PartnerAgreement!
    createSettlement(partnerId: ID!, period: String!, deductions: [SettlementDeductionInput!]): Settlement!
    accrueSettlement(id: ID!): Settlement!
    paySettlement(input: PaySettlementInput!): Settlement!
    cancelSettlement(id: ID!): Settlement!

    closeCashDay(input: CloseCashDayInput!): CashClosing!
    importBankStatement(input: BankImportInput!): BankImportResult!
    reconcileBank(ledgerId: ID!, statementId: ID): ReconcileResult!
    matchBankLine(lineId: ID!, voucherIds: [ID!]!): BankLine!
    setBankLineStatus(lineId: ID!, status: BankLineManualStatus!): BankLine!

    setLockDate(input: LockDateInput!): PeriodLock!
    "Closing vouchers on 31 March and a lock. fy: 2026-27."
    closeFinancialYear(fy: String!): YearEndResult!
  }
`;
