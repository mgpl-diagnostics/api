/** The books (ledger-kit, our accounting engine): chart of accounts, vouchers, reports. */
export const booksTypeDefs = /* GraphQL */ `
  enum AccountNature { assets liabilities income expenses }
  enum VoucherStatus { posted cancelled }
  enum AgeBucket { D0_30 D31_60 D61_90 D90_PLUS }

  type AccountGroup { id: ID!, name: String!, nature: AccountNature!, parent: AccountGroup, affectsGrossProfit: Boolean! }

  type Ledger {
    id: ID!
    name: String!
    group: AccountGroup!
    openingPaise: Int!
    systemKey: String
    gstin: String
    active: Boolean!
    "Closing balance, positive = Debit."
    balancePaise(asOf: DateTime, branchId: ID): Int!
  }

  type VoucherEntry { ledger: Ledger!, debitPaise: Int!, creditPaise: Int!, invoiceId: ID }

  type Voucher {
    id: ID!
    type: VoucherType!
    voucherNo: String!
    date: DateTime!
    narration: String
    status: VoucherStatus!
    entries: [VoucherEntry!]!
    branch: Branch!
    invoiceId: ID
  }

  type StatementRow { date: DateTime!, voucherNo: String!, voucherType: VoucherType!, debitPaise: Int!, creditPaise: Int!, balancePaise: Int!, invoiceId: ID }
  type LedgerStatement { ledger: Ledger!, openingPaise: Int!, closingPaise: Int!, totalDebitPaise: Int!, totalCreditPaise: Int!, rows: [StatementRow!]! }
  type TrialBalanceRow { ledger: Ledger!, group: AccountGroup!, primaryGroup: AccountGroup!, debitPaise: Int!, creditPaise: Int! }
  type TrialBalance { rows: [TrialBalanceRow!]!, totalDebitPaise: Int!, totalCreditPaise: Int!, differencePaise: Int! }
  type LedgerAmount { ledger: Ledger!, amountPaise: Int! }
  type GroupLine { group: AccountGroup!, amountPaise: Int!, ledgers: [LedgerAmount!]! }
  type ProfitAndLoss { income: [GroupLine!]!, expenses: [GroupLine!]!, grossProfitPaise: Int!, netProfitPaise: Int! }
  type BalanceSheet { assets: [GroupLine!]!, liabilities: [GroupLine!]!, profitPaise: Int!, totalAssetsPaise: Int!, totalLiabilitiesPaise: Int!, differencePaise: Int! }
  type OutstandingRow { invoice: Invoice!, ageDays: Int!, bucket: AgeBucket! }
  type BucketTotals { d0to30: Int!, d31to60: Int!, d61to90: Int!, d90plus: Int! }
  type Outstanding { rows: [OutstandingRow!]!, buckets: BucketTotals!, totalDuePaise: Int! }
  type GstSummary { taxableValuePaise: Int!, cgstPaise: Int!, sgstPaise: Int!, igstPaise: Int!, totalTaxPaise: Int! }

  extend type Query {
    accountGroups: [AccountGroup!]!
    ledgers: [Ledger!]!
    ledger(id: ID!): Ledger
    voucher(id: ID!): Voucher
    ledgerStatement(ledgerId: ID!, from: DateTime!, to: DateTime!, branchId: ID): LedgerStatement!
    cashBook(from: DateTime!, to: DateTime!, branchId: ID): LedgerStatement!
    trialBalance(asOf: DateTime, branchId: ID): TrialBalance!
    profitAndLoss(from: DateTime!, to: DateTime!, branchId: ID): ProfitAndLoss!
    balanceSheet(asOf: DateTime!, branchId: ID): BalanceSheet!
    dayBook(from: DateTime!, to: DateTime!, branchId: ID, type: VoucherType): [Voucher!]!
    outstandingReceivables(asOf: DateTime, branchId: ID): Outstanding!
    gstSummary(from: DateTime!, to: DateTime!, branchId: ID): GstSummary!
  }

  input VoucherEntryInput { ledgerId: ID!, debitPaise: Int = 0, creditPaise: Int = 0, invoiceId: ID }
  input PostVoucherInput { branchId: ID!, type: VoucherType!, date: DateTime, narration: String, entries: [VoucherEntryInput!]! }
  input LedgerInput { name: String!, groupId: ID!, openingPaise: Int = 0, gstin: String }

  extend type Mutation {
    "Seeds the standard chart (28 groups, default ledgers) and finance-kit's ledgers. Idempotent."
    setupChartOfAccounts: [Ledger!]!
    createLedger(input: LedgerInput!): Ledger!
    postVoucher(input: PostVoucherInput!): Voucher!
    cancelVoucher(id: ID!): Voucher!
  }
`;
