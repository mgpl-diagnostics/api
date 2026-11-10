/** The installation itself: versions and update notices for owners and admins. */
export const systemTypeDefs = /* GraphQL */ `
  "A published release of the api or the dashboard (its GitHub release). notes is the changelog, in Markdown."
  type Release { version: String!, name: String, notes: String, url: String, publishedAt: DateTime }

  "One part of the installation: the version that runs, the newest release, and the releases in between."
  type ComponentUpdate {
    "api or dashboard"
    component: String!
    "The version that runs; null for the dashboard when it did not say (dashboardVersion)."
    current: String
    "The newest published release; null before the first check or when the check is off."
    latest: String
    updateAvailable: Boolean!
    "Docker image, e.g. ghcr.io/mgpl-diagnostics/api (tags: 1.2.3, 1.2, 1, latest)."
    image: String!
    "Releases newer than current, newest first (at most 20); the newest release alone when current is unknown."
    changes: [Release!]!
  }

  type SystemUpdates {
    "false when the server has UPDATE_CHECK=false (no outbound calls); versions then show current only."
    enabled: Boolean!
    "When the releases were last read (each server checks every UPDATE_CHECK_INTERVAL_MS, 6 hours by default)."
    checkedAt: DateTime
    "Why the last check failed (the releases shown are then the last known)."
    error: String
    updateAvailable: Boolean!
    components: [ComponentUpdate!]!
    "How to update a Docker Compose installation, one step per line."
    steps: [String!]!
    "The update guide."
    docsUrl: String!
  }

  extend type Query {
    """
    Owner and admin (settings:manage): is a newer api or dashboard release out, what changed, and how to
    update. The dashboard passes its own version; refresh skips the cache (at most once a minute).
    """
    systemUpdates(dashboardVersion: String, refresh: Boolean): SystemUpdates!
  }
`;
