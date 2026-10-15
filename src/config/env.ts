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
  /**
   * The database. `url` may point at PgBouncer instead of PostgreSQL (docs/17-scaling.md); `pool` sizes this
   * process's own connection pool (Sequelize for pg, the MongoDB driver for mongo); `sync` creates missing
   * tables / indexes on start (turn it off on all but one replica, or run it once per release).
   */
  db: { backend: DbBackend; url: string; sync: boolean; pool: { max: number; min: number; idleMs: number; acquireMs: number } };
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
  /** Reverse proxies in front of the API that append to X-Forwarded-For (TRUST_PROXY). 0 = use the socket address. */
  trustedHops: number;
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
  /**
   * Mail (mail-kit): `SMTP_URL` (smtps://user:pass@host:465 or smtp://…:587) and the sender `MAIL_FROM`.
   * Preferred over `mailWebhookUrl` when both are set.
   */
  smtp: { url: string; from: string } | null;
  /** Optional HTTP relay for emails sent by the worker: POST { to, subject, text } as JSON. */
  mailWebhookUrl: string | null;
  /**
   * Graceful shutdown on SIGTERM / SIGINT: GET /health answers 503 at once, the server keeps serving for
   * `drainMs` so the load balancer stops sending traffic, then stops accepting connections and waits for the
   * requests in flight; after `timeoutMs` in all it exits anyway.
   */
  shutdown: { drainMs: number; timeoutMs: number };
}

/**
 * Loads `.env` from the working directory into `process.env`, if the file exists. Variables already set
 * in the environment win over the file. Called by `main.ts`, `worker.ts` and `scripts/seed.ts`; an app
 * that embeds the API configures its own environment.
 */
export function loadEnvFile(path = ".env"): void {
  if (typeof process.loadEnvFile !== "function") return; // Node < 20.12: export the variables instead
  try {
    process.loadEnvFile(path);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
}

const bool = (v: string | undefined, d: boolean) => (v == null || v === "" ? d : ["1", "true", "yes", "on"].includes(v.toLowerCase()));
const int = (v: string | undefined, d: number) => {
  if (v == null || v === "") return d;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0) throw new Error(`Expected a whole number, got "${v}"`);
  return n;
};

/** TRUST_PROXY: "false"/"0" (default), "true" (= 1 proxy), or the number of proxies (CDN + load balancer = 2). */
function hops(v: string | undefined): number {
  if (v === undefined || v === "") return 0;
  if (/^(true|yes|on)$/i.test(v)) return 1;
  if (/^(false|no|off)$/i.test(v)) return 0;
  return int(v, 0);
}

/** DB_POOL_*: connections this process keeps open (to PgBouncer or the database). Replicas × max must fit the server side. */
function dbPool(env: Record<string, string | undefined>): Config["db"]["pool"] {
  const max = int(env.DB_POOL_MAX, 10);
  const min = int(env.DB_POOL_MIN, 0);
  if (max < 1) throw new Error("DB_POOL_MAX must be at least 1");
  if (min > max) throw new Error(`DB_POOL_MIN (${min}) cannot be larger than DB_POOL_MAX (${max})`);
  return { max, min, idleMs: int(env.DB_POOL_IDLE_MS, 10_000), acquireMs: int(env.DB_POOL_ACQUIRE_MS, 30_000) };
}

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
  const smtpUrl = env.SMTP_URL || null;
  if (smtpUrl && !/^smtps?:\/\//.test(smtpUrl)) throw new Error("SMTP_URL must start with smtp:// or smtps://");
  if (smtpUrl && !env.MAIL_FROM && !dev) throw new Error('MAIL_FROM is required with SMTP_URL (e.g. "Maa Gayatri Path Lab <no-reply@your-domain>")');
  return {
    env: mode,
    host: env.HOST ?? "0.0.0.0",
    port: int(env.PORT, 4000),
    graphqlPath: env.GRAPHQL_PATH ?? "/graphql",
    db: {
      backend,
      url,
      sync: bool(env.DB_SYNC, true),
      pool: dbPool(env),
    },
    redisUrl: env.REDIS_URL || null,
    corsOrigins,
    graphiql: bool(env.GRAPHIQL, dev),
    introspection: bool(env.INTROSPECTION, dev),
    bodyLimit: int(env.BODY_LIMIT_BYTES, 2_000_000),
    trustedHops: hops(env.TRUST_PROXY),
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
    smtp: smtpUrl ? { url: smtpUrl, from: env.MAIL_FROM || "MGPL Diagnostics <no-reply@localhost.localdomain>" } : null,
    mailWebhookUrl: env.MAIL_WEBHOOK_URL || null,
    shutdown: { drainMs: int(env.SHUTDOWN_DRAIN_MS, mode === "production" ? 5_000 : 0), timeoutMs: int(env.SHUTDOWN_TIMEOUT_MS, 30_000) },
  };
}
