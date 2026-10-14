/** The test catalog (catalog-kit): tests, parameters, ranges, sample types, prices, search. */
export const catalogTypeDefs = /* GraphQL */ `
  enum ParameterType { numeric text options image title }

  type CatalogInterval { low: String, high: String }

  type CatalogParameter {
    name: String
    unit: String
    method: String
    type: ParameterType!
    male: CatalogInterval
    female: CatalogInterval
    options: [String!]
    calculated: Boolean!
    "Readable formula of a calculated parameter."
    formulaText: String
    referenceText: String
    "The printed range for a sex (or both)."
    range(sex: Sex): String!
  }

  type CatalogTest {
    id: Int!
    name: String!
    code: String
    shortCode: String
    department: String!
    sampleType: String
    secondarySampleTypes: [String!]
    "MRP in rupees."
    mrp: Int
    "MRP in paise (what bookings and invoices use)."
    pricePaise: Int
    isProfile: Boolean!
    parameterCount: Int!
    parameters: [CatalogParameter!]!
  }

  type CatalogHit { test: CatalogTest!, score: Float! }
  type PriceQuote { "Rupees." total: Int!, totalPaise: Int!, tests: [CatalogTest!]!, unknown: [String!]! }

  extend type Query {
    "Typo-tolerant search with lab shorthand (cbc, lft, vit d…)."
    catalogSearch(query: String!, limit: Int = 20, department: String, sampleType: String, fuzzy: Boolean = true): [CatalogHit!]!
    catalogTest(id: Int, code: String): CatalogTest
    catalogTests(department: String, sampleType: String, limit: Int = 50, offset: Int = 0): [CatalogTest!]!
    catalogDepartments: [String!]!
    catalogSampleTypes: [String!]!
    "Total MRP for test codes (or numeric ids as strings)."
    priceQuote(tests: [String!]!): PriceQuote!
  }
`;
