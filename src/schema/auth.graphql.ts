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

  type Session {
    id: ID!
    current: Boolean!
    createdAt: DateTime!
    lastSeenAt: DateTime!
    expiresAt: DateTime!
    ip: String
    userAgent: String
    "The device id sent at sign-in: refresh tokens of this session work only there."
    deviceId: String
    "The latest device description the client sent (platform, language, timezone, screen, …)."
    deviceInfo: JSON
  }

  """
  Security signals the client sends with login and refreshSession (the client SDK collects them).
  All optional; malformed values are dropped. See docs/06-authentication.md.
  """
  input DeviceInput {
    "Random id the client keeps per browser profile or app install (8-128 of A-Z a-z 0-9 _ . : + / = -)."
    deviceId: String
    "Client-side hash of stable device attributes. A change is logged, never blocked."
    fingerprint: String
    "Random id per tab or app run."
    clientSessionId: String
    "Descriptive values: at most 20 keys, short strings, numbers or booleans."
    info: JSON
  }

  """
  Tokens after login or refresh. Send the access token as 'Authorization: Bearer <accessToken>'; when
  it expires (UNAUTHENTICATED), trade the refresh token for a new pair with refreshSession.
  """
  type LoginResult {
    "Short-lived HS256 JWT (default 15 minutes). Every request still checks the session and re-reads the user."
    accessToken: String!
    accessExpiresAt: DateTime!
    "Opaque and single-use: refreshSession returns the next one. The server stores only its SHA-256."
    refreshToken: String!
    "Slides with each refresh (idle window), never past the session's maximum age."
    refreshExpiresAt: DateTime!
    user: User!
    "Same as accessToken."
    token: String! @deprecated(reason: "Use accessToken.")
    "Same as accessExpiresAt."
    expiresAt: DateTime! @deprecated(reason: "Use accessExpiresAt.")
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

  input LoginInput { email: String!, password: String!, "Only when the same email exists in several organisations." orgCode: String, device: DeviceInput }
  input CreateUserInput { name: String!, email: String!, phone: String, password: String!, roles: [RoleAssignmentInput!]! }
  input RoleInput { key: String!, name: String!, permissions: [String!]! }

  extend type Mutation {
    login(input: LoginInput!): LoginResult!
    """
    Spends a refresh token and returns a new access token and the next refresh token. A refresh token
    used twice ends its session (it was copied); within a few seconds (two tabs) the second use only fails.
    Send the same device as at login: a refresh from another device id ends the session (DEVICE_BINDING).
    INVALID_TOKEN when it is unknown, spent or expired: sign in again.
    """
    refreshSession(refreshToken: String!, device: DeviceInput): LoginResult!
    "Ends this session: the bearer token (even an expired access token), or the refresh token when given."
    logout(refreshToken: String): Boolean!
    "Ends every other session of the signed-in user; returns how many."
    logoutOtherSessions: Int!
    revokeSession(id: ID!): Boolean!
    changePassword(currentPassword: String!, newPassword: String!): Boolean!
    "Always true (never reveals whether the email exists). Queued: the worker creates the single-use token and mails the link."
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
