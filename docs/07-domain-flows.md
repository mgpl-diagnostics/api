# 07 · Domain flows

## The lab day, end to end

```mermaid
flowchart LR
  P["registerPatient"] --> B["createBooking<br/>(tests from the catalog)"]
  B --> S["samples created<br/>one per sample type"]
  B --> I["issueInvoice<br/>(bookingId, items by code)"]
  I --> V1["sales voucher posted<br/>(GST split, finance-kit)"]
  I --> PAY["recordPayment"] --> V2["receipt voucher"]
  S --> C["collectSample"] --> R["receiveSample"]
  R --> RP["createReport → saveResults<br/>(unit, range, flag from catalog)"]
  RP --> VR["verifyReport"] --> RL["releaseReport"]
  RL --> D["bookingReportDocument<br/>PDF / HTML"]
  I --> ID["invoiceDocument<br/>PDF / HTML"]
```

## Booking

```mermaid
stateDiagram-v2
  [*] --> booked: createBooking
  booked --> sample_collected: first collectSample
  booked --> in_process: receiveSample
  sample_collected --> in_process: receiveSample
  in_process --> completed: last report released
  booked --> cancelled: cancelBooking
  sample_collected --> cancelled: cancelBooking
  in_process --> cancelled: cancelBooking
  note right of cancelled: needs the booking's invoice cancelled first
```

`createBooking` accepts `tests: [{ testCode }]`; the name, price (paise) and sample type come from the
catalog unless given. One sample (with a barcode) is created per distinct sample type.

## Sample

```mermaid
stateDiagram-v2
  [*] --> pending
  pending --> collected: collectSample
  collected --> received: receiveSample
  pending --> rejected: rejectSample(reason)
  collected --> rejected: rejectSample(reason)
  received --> rejected: rejectSample(reason)
```

## Report

```mermaid
stateDiagram-v2
  [*] --> draft: createReport
  draft --> entered: saveResults
  entered --> entered: saveResults (again)
  entered --> verified: verifyReport
  verified --> released: releaseReport
  released --> amended: amendReport
  amended --> verified: verifyReport
```

`saveResults` fills `unit`, `range` (by the patient's sex) and `flag` (L / H by the reference interval) from
the catalog when the client leaves them out. `flag: NONE` means normal. Releasing the last report of a
booking marks the booking `completed`. `bookingReportDocument` prints verified or released reports only ([08-documents.md](08-documents.md)).

## Invoice and payments

```mermaid
stateDiagram-v2
  [*] --> issued: issueInvoice (nothing paid)
  [*] --> partially_paid: issueInvoice with part payment
  [*] --> paid: issueInvoice paid in full
  issued --> partially_paid: recordPayment
  partially_paid --> paid: recordPayment
  issued --> paid: recordPayment
  paid --> partially_paid: refundPayment (part)
  paid --> refunded: refundPayment (all)
  issued --> credited: issueCreditNote (whole value)
  partially_paid --> credited: issueCreditNote
  issued --> cancelled: cancelInvoice(reason)
  refunded --> cancelled: cancelInvoice(reason)
  note right of cancelled: only with nothing paid; refund first
```

- Items may be just `{ code: "CBC" }`: name and MRP come from the catalog. `applyTaxRules: true` takes
  HSN/SAC, taxability and rate from the organisation's tax rules (diagnostic services are usually exempt).
- Arithmetic (db-kit, integer paise): line gross → line discount → bill discount shared by largest
  remainder → GST → round-off to the rupee.
- Every issue, payment, refund, credit note and cancel posts a voucher **in the same transaction**
  (`financePosting` → ledger-kit). A failed posting rolls the whole operation back.

```mermaid
sequenceDiagram
  participant API as billing service
  participant DB as db-kit issueInvoice
  participant H as financePosting (hook)
  participant T as ledger-kit postVoucher
  API->>DB: repos.transaction(tx => …)
  DB->>DB: compute totals, number MGPL/ARG01/2026-27/000123
  DB->>H: invoiceIssued(tx, invoice)
  H->>H: place of supply from branch stateCode → CGST+SGST or IGST
  H->>T: sales voucher (Dr patient/customer, Cr income, Cr output GST)
  T->>T: assertPeriodOpen (lock dates), assertBalanced
  T-->>DB: voucher
  DB-->>API: invoice (committed with its voucher)
```

## B2B receivables

```mermaid
flowchart LR
  CU["createCustomer<br/>(credit limit, days)"] --> CI["issueCustomerInvoice"]
  CI --> CS["customerStatement<br/>open items, ageing"]
  CI --> CN["issueCreditNote<br/>(lines or whole)"]
  CS --> RS["receivablesSummary"]
```

`issueCustomerInvoice` refuses with `CREDIT_LIMIT_EXCEEDED` when the customer's open balance plus this
invoice exceeds the limit. Credit notes reverse tax line by line and reduce what is owed.

## Partner settlements (collection centres, franchises)

```mermaid
stateDiagram-v2
  [*] --> draft: createSettlement(partner, "2026-09")
  draft --> accrued: accrueSettlement (journal: expense / partner)
  accrued --> paid: paySettlement (payment voucher, TDS)
  draft --> cancelled: cancelSettlement
  accrued --> cancelled: cancelSettlement (reverses accrual)
  note right of paid: corrections go into the next month
```

`settlementPreview` computes the month without saving: lines per invoice from the partner's agreements
(revenue share in basis points, or fixed rates per test code), deductions, TDS (section and rate from the
partner or the finance config) and net. No doctor referral commissions: settlements are for collection
centres and franchises only.

## Cash and bank

```mermaid
flowchart LR
  subgraph Cash
    CC["closeCashDay(branch, day, counted)"] --> DIFF{"book = counted?"}
    DIFF -- no --> J["journal for the difference"]
  end
  subgraph Bank
    IM["importBankStatement(csv)"] --> RC["reconcileBank<br/>auto-match, card/UPI settlements with MDR"]
    RC --> UM["bankLines(status: unmatched)"]
    UM --> MB["matchBankLine / setBankLineStatus"]
    MB --> BR["bankReconciliation (BRS)"]
  end
```

## Periods

```mermaid
stateDiagram-v2
  direction LR
  [*] --> open
  open --> locked: setLockDate(upTo)
  locked --> open: setLockDate(null)
  open --> closed: closeFinancialYear("2026-27")
  note right of locked: postings on or before upTo fail with PERIOD_LOCKED
```

`closeFinancialYear` posts the closing vouchers on 31 March (income and expenses into capital) and locks
the year. Lock dates are checked inside the posting transaction, so nothing slips past them.

## Books

`setupChartOfAccounts` seeds the 28 standard groups, the default ledgers and finance-kit's ledgers
(idempotent; the seed script runs it). Reports: `trialBalance`, `ledgerStatement`, `cashBook`, `dayBook`,
`profitAndLoss`, `balanceSheet`, `outstandingReceivables`, `gstSummary`. Manual entries go through
`postVoucher` (balanced, one side per line) and `cancelVoucher`.
