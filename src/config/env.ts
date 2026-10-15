import { randomBytes } from "node:crypto";

// Runtime configuration, read once from the environment. Every value has a safe development default;
// production sets them explicitly (see docs/09-configuration.md).

export type DbBackend = "pg" | "mongo";

export interface Config {
  env: "development" | "production" | "test";
  host: string;
  port: number;
  /** URL path of the one GraphQL endpoint. */
  graphqlPath: string;
  db: { backend: DbBackend; url: string };
  /** Sessions, reset tokens, rate limits and the read cache. Without it they live in process memory (one server only). */
  redisUrl: string | null;
  /** Origins allowed to call the API from a browser; "*" only in development. */
  corsOrigins: string[];
  /** GraphiQL in the browser at the GraphQL path (development only by default). */
  graphiql: boolean;
  /** Enables introspection (schema download). Development only by default. */
  introspection: boolean;
  /** Largest request body, bytes. */
  bodyLimit: number;
  /** Behind a proxy (nginx, a load balancer): read the client IP from X-Forwarded-For. */
  trustProxy: boolean;
  /** Demo report and invoice samples (report-kit / invoice-kit) in `documents`. */
  samples: boolean;
  /** Session lifetime knobs, passed to auth-kit. */
  session: { idleMs: number; maxAgeMs: number };
  /** Password-reset links point here: `${resetUrl}?token=…`. */
  resetUrl: string | null;
  /**
   * Access tokens (HS256 JWT) and refresh tokens. `secrets[0]` signs, every one verifies (rotation).
   * Development without JWT_SECRET uses a random secret per process (tokens die on restart).
   */
  jwt: { secrets: string[]; issuer: string; accessTtlMs: number; generated: boolean };
  /** A refresh from another device: "enforce" ends the session (default), "flag" only audits, "off" ignores. */
  deviceBinding: "enforce" | "flag" | "off";
  /** Background jobs (BullMQ on REDIS_URL): key prefix and how many jobs a worker runs at once. */
  jobs: { prefix: string; concurrency: number; keepResultsMs: number };
  /** Optional HTTP relay for emails sent by the worker: POST { to, subject, text } as JSON. */
  mailWebhookUrl: string | null;
}

const bool = (v: string | undefined, d: boolean) => (v == null || v === "" ? d : ["1", "true", "yes", "on"].includes(v.toLowerCase()));
const int = (v: string | undefined, d: number) => {
  if (v == null || v === "") return d;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0) throw new Error(`Expected a whole number, got "${v}"`);
  return n;
};

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const mode = env.NODE_ENV === "production" ? "production" : env.NODE_ENV === "test" ? "test" : "development";
  const dev = mode !== "production";
  const backend = (env.DB_BACKEND ?? "pg") as DbBackend;
  if (backend !== "pg" && backend !== "mongo") throw new Error(`DB_BACKEND must be "pg" or "mongo", got "${backend}"`);
  const url = env.DATABASE_URL ?? (dev ? (backend === "pg" ? "postgres://postgres:postgres@localhost:5432/mgpl" : "mongodb://localhost:27017/mgpl?replicaSet=rs0") : "");
  if (!url) throw new Error("DATABASE_URL is required in production");
  const corsOrigins = (env.CORS_ORIGINS ?? (dev ? "*" : "")).split(",").map((s) => s.trim()).filter(Boolean);
  if (!dev && corsOrigins.includes("*")) throw new Error('CORS_ORIGINS cannot be "*" in production');
  const secrets = (env.JWT_SECRET ?? "").split(",").map((v) => v.trim()).filter(Boolean);
  if (!secrets.length && !dev) throw new Error("JWT_SECRET is required in production (at least 32 characters; comma-separate to rotate)");
  if (secrets.some((v) => v.length < 32)) throw new Error("Every JWT_SECRET needs at least 32 characters");
  const deviceBinding = (env.DEVICE_BINDING || "enforce") as Config["deviceBinding"];
  if (!["enforce", "flag", "off"].includes(deviceBinding)) throw new Error(`DEVICE_BINDING must be enforce, flag or off, got "${deviceBinding}"`);
  return {
    env: mode,
    host: env.HOST ?? "0.0.0.0",
    port: int(env.PORT, 4000),
    graphqlPath: env.GRAPHQL_PATH ?? "/graphql",
    db: { backend, url },
    redisUrl: env.REDIS_URL || null,
    corsOrigins,
    graphiql: bool(env.GRAPHIQL, dev),
    introspection: bool(env.INTROSPECTION, dev),
    bodyLimit: int(env.BODY_LIMIT_BYTES, 2_000_000),
    trustProxy: bool(env.TRUST_PROXY, false),
    samples: bool(env.MGPL_SAMPLES, dev),
    session: { idleMs: int(env.SESSION_IDLE_MS, 12 * 3600_000), maxAgeMs: int(env.SESSION_MAX_AGE_MS, 30 * 86400_000) },
    resetUrl: env.PASSWORD_RESET_URL || null,
    jwt: {
      secrets: secrets.length ? secrets : [randomBytes(32).toString("base64url")],
      issuer: env.JWT_ISSUER || "mgpl-api",
      accessTtlMs: int(env.ACCESS_TOKEN_TTL_MS, 15 * 60_000),
      generated: !secrets.length,
    },
    deviceBinding,
    jobs: { prefix: env.QUEUE_PREFIX || "mgpl", concurrency: Math.max(1, int(env.WORKER_CONCURRENCY, 4)), keepResultsMs: int(env.JOB_RESULT_TTL_MS, 3600_000) },
    mailWebhookUrl: env.MAIL_WEBHOOK_URL || null,
  };
}
