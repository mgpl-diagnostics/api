/** The organisation, its branches and the audit trail. */
export const organizationTypeDefs = /* GraphQL */ `
  enum BranchKind { lab collection_center }

  type Organization {
    id: ID!
    name: String!
    code: String!
    legalName: String
    gstin: String
    phone: String
    email: String
    address: Address
    branches: [Branch!]!
  }

  type Branch { id: ID!, code: String!, name: String!, kind: BranchKind!, phone: String, gstin: String, stateCode: String, address: Address, active: Boolean! }

  type AuditEntry { id: ID!, action: String!, entity: String, entityId: ID, branchId: ID, user: User, ip: String, data: JSON, at: DateTime! }

  extend type Query {
    organization: Organization!
    branches: [Branch!]!
    branch(id: ID!): Branch
    auditLog(entity: String, entityId: ID, limit: Int = 50, offset: Int = 0): [AuditEntry!]!
  }

  input OrganizationInput { name: String, legalName: String, gstin: String, phone: String, email: String, address: AddressInput }
  input BranchInput { code: String!, name: String!, kind: BranchKind!, phone: String, gstin: String, stateCode: String, address: AddressInput, active: Boolean }
  input BranchPatch { name: String, kind: BranchKind, phone: String, gstin: String, stateCode: String, address: AddressInput, active: Boolean }

  extend type Mutation {
    updateOrganization(input: OrganizationInput!): Organization!
    createBranch(input: BranchInput!): Branch!
    updateBranch(id: ID!, input: BranchPatch!): Branch!
  }
`;
