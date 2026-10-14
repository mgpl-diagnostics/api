# 15 · Glossary

| Term | Meaning |
|---|---|
| **Booking** | A patient's order for one or more tests on one visit |
| **Sample** | A specimen (blood, urine, …) collected for a booking, with a barcode; one per sample type |
| **Report** | The results of one test for a booking; goes draft → entered → verified → released |
| **Template** | report-kit's layout for a test (rows, units, ranges); results keyed by field |
| **Profile** | A group of tests sold together (e.g. LFT, KFT) |
| **UHID** | Unique health ID: the lab's patient number |
| **MRP** | Maximum retail price of a test, in rupees, from the catalog |
| **Paise** | 1/100 of a rupee; every amount in the API is integer paise |
| **Branch** | A lab or collection centre of the organisation; holds its own stock of patients, bookings, cash |
| **Header / non-header** | Print with the letterhead, or without it for pre-printed stationery |
| **Voucher** | A double-entry accounting document: sales, receipt, payment, journal, contra, credit note, … |
| **Ledger** | An account (Cash, Bank, Sales, a customer, a partner) inside an account group |
| **Trial balance** | Every ledger's debit/credit balance; totals must be equal |
| **Day book** | All vouchers of a period |
| **Lock date** | No posting on or before it (period closed) |
| **Financial year (FY)** | 1 April – 31 March, written `2026-27` |
| **GSTIN** | 15-character GST registration number; its first two digits are the state code |
| **State code** | GST code of a state (22 = Chhattisgarh); decides CGST+SGST (same state) vs IGST |
| **Place of supply** | The state where the service is supplied, for GST |
| **HSN / SAC** | Classification codes for goods / services on invoices |
| **GSTR-1 / GSTR-3B** | Monthly GST returns: outward supplies detail / summary with tax payable |
| **B2B / B2C / B2CL / B2CS** | Supplies to registered businesses / consumers (large / small) |
| **CDNR / CDNUR** | Credit and debit notes to registered / unregistered buyers |
| **Credit note** | Reduces an issued invoice (with its tax); our "partial cancel" |
| **Receivable** | Money owed by B2B customers (hospitals, insurers, TPAs, corporates) |
| **Ageing** | Open amounts by how overdue they are (0–30, 31–60, 61–90, 90+ days) |
| **Partner** | A collection centre or franchise that earns a share of billing |
| **Settlement** | A month's partner share: preview → draft → accrued → paid |
| **TDS** | Tax deducted at source on payments to partners (section and rate are CA-confirmed config) |
| **bp (basis points)** | 1/100 of a percent: 2500 bp = 25 % |
| **MDR** | Merchant discount rate: the card/UPI fee the bank deducts from settlements |
| **BRS** | Bank reconciliation statement: book balance vs bank balance and the items between |
| **Verify with CA** | Values (rates, thresholds, sections) the lab's chartered accountant must confirm |
| **Kit** | One of our libraries (auth, db, catalog, report, invoice, tally, finance) used inside the API |
| **Actor** | `{ userId, orgId }` of the signed-in user, from the session |
