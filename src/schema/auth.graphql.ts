/** Sign-in, sessions, passwords (auth-kit) and users and roles. */
export const authTypeDefs = /* GraphQL */ `
  enum UserStatus { active disabled invited }

  type RoleAssignment { role: String!, branchId: ID, branch: Branch }
  input RoleAssignmentInput { role: String!, branchId: ID }

  type User {
    id: ID!
    name: String!
    email: String!
    phone: String
    status: UserStatus!
    roles: [RoleAssignment!]!
    lastLoginAt: DateTime
    createdAt: DateTime!
  }

  type Role { id: ID!, key: String!, name: String!, permissions: [String!]!, system: Boolean! }

  "The signed-in user and what they may do."
  type Viewer {
    user: User!
    organization: Organization!
    "Permissions held in this branch (or organisation-wide when branchId is omitted)."
    permissions(branchId: ID): [String!]!
    "Branches where the user has this permission; null means every branch."
    branchesFor(permission: String!): [ID!]
    can(permission: String!, branchId: ID): Boolean!
  }

  type Session { id: ID!, current: Boolean!, createdAt: DateTime!, lastSeenAt: DateTime!, expiresAt: DateTime!, ip: String, userAgent: String }

  type LoginResult {
    "Send as 'Authorization: Bearer <token>'. Shown once; the server stores only its SHA-256."
    token: String!
    expiresAt: DateTime!
    user: User!
  }

  extend type Query {
    "null when not signed in."
    viewer: Viewer
    mySessions: [Session!]!
    users: [User!]!
    user(id: ID!): User
    roles: [Role!]!
    "Every permission name the API checks."
    permissions: [String!]!
  }

  input LoginInput { email: String!, password: String!, "Only when the same email exists in several organisations." orgCode: String }
  input CreateUserInput { name: String!, email: String!, phone: String, password: String!, roles: [RoleAssignmentInput!]! }
  input RoleInput { key: String!, name: String!, permissions: [String!]! }

  extend type Mutation {
    login(input: LoginInput!): LoginResult!
    "Ends this session."
    logout: Boolean!
    "Ends every other session of the signed-in user; returns how many."
    logoutOtherSessions: Int!
    revokeSession(id: ID!): Boolean!
    changePassword(currentPassword: String!, newPassword: String!): Boolean!
    "Always true (never reveals whether the email exists). The link is sent by the server's mailer."
    requestPasswordReset(email: String!, orgCode: String): Boolean!
    resetPassword(token: String!, newPassword: String!): Boolean!

    createUser(input: CreateUserInput!): User!
    setUserRoles(userId: ID!, roles: [RoleAssignmentInput!]!): User!
    disableUser(userId: ID!): User!
    enableUser(userId: ID!): User!
    setUserPassword(userId: ID!, newPassword: String!): Boolean!
    upsertRole(input: RoleInput!): Role!
  }
`;
