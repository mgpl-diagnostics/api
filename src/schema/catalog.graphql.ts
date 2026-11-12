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
    "An interpretation / clinical significance / note block: printed under the test, never entered as a result."
    narrative: Boolean!
  }

  "What a catalog entry is. Ids are numbered per kind."
  enum CatalogKind { test profile package }

  type CatalogTest {
    "MGPL id: MGPLT0001 (test), MGPLP0001 (profile), MGPLK0001 (package). Never changes or is reused."
    id: ID!
    kind: CatalogKind!
    "The lab software's old numeric id (the id before catalog-kit 2); null for entries added since."
    legacyId: Int
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
    "A profile or a package (several tests sold together)."
    isProfile: Boolean!
    isPackage: Boolean!
    parameterCount: Int!
    parameters: [CatalogParameter!]!
  }

  type CatalogHit { test: CatalogTest!, score: Float! }
  type PriceQuote { "Rupees." total: Int!, totalPaise: Int!, tests: [CatalogTest!]!, unknown: [String!]! }

  extend type Query {
    "Typo-tolerant search with lab shorthand (cbc, lft, vit d…)."
    catalogSearch(query: String!, limit: Int = 20, department: String, sampleType: String, fuzzy: Boolean = true): [CatalogHit!]!
    "By MGPL id (MGPLT0001), old numeric id (10409) or code (CBC)."
    catalogTest(id: ID, code: String): CatalogTest
    catalogTests(department: String, sampleType: String, limit: Int = 50, offset: Int = 0): [CatalogTest!]!
    catalogDepartments: [String!]!
    catalogSampleTypes: [String!]!
    "Total MRP for test codes, MGPL ids, or old numeric ids as strings."
    priceQuote(tests: [String!]!): PriceQuote!
  }
`;
