/**
 * Shared scalars, enums and the root types. Money is Int paise (Rs 1 = 100). Instants are DateTime
 * (ISO-8601, UTC); calendar days are Day ("2026-10-14", IST). Every query is scoped to the signed-in
 * user's organisation: nothing takes an orgId.
 */
export const baseTypeDefs = /* GraphQL */ `
  scalar DateTime
  scalar Day
  scalar JSON

  enum Sex { male female other }
  enum PaymentMode { cash upi card netbanking wallet cheque insurance }
  enum ItemCategory { test package service consumable medicine other }
  enum Taxability { taxable exempt nil_rated non_gst }
  enum VoucherType { sales receipt payment journal contra credit_note debit_note purchase closing }

  type Address { line1: String, line2: String, city: String, district: String, state: String, pincode: String }
  input AddressInput { line1: String, line2: String, city: String, district: String, state: String, pincode: String }

  "Service health: database reachable, versions."
  type Health { ok: Boolean!, service: String!, version: String!, database: String!, time: DateTime! }

  type Query {
    health: Health!
  }

  type Mutation {
    "Does nothing; lets clients check that mutations reach the server."
    ping: String!
  }
`;
