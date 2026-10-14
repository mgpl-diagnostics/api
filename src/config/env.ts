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
  };
}
