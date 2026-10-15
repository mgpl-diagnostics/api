import { createAuth, memoryKeyValueStore, memoryRateLimiter, memorySessionStore, type Auth } from "@mgpl-diagnostics/auth-kit";
import { createDb, type Db } from "@mgpl-diagnostics/db-kit";
import { financePosting } from "@mgpl-diagnostics/finance-kit";
import type { LabProfile } from "@mgpl-diagnostics/report-kit";
import type { Config } from "./config/env";
import { createBullJobQueue, createInlineJobQueue, webhookMailer, type JobDeps, type JobQueue } from "./jobs";
import { createServices, type Mailer, type Services } from "./services";

export interface ContainerOptions {
  config: Config;
  /** Inject a database (tests). Default: createDb from config, posting through finance-kit. */
  db?: Db;
  /** Inject auth (tests). Default: auth-kit on db-kit's users/orgs/roles/audit, sessions in Redis or memory. */
  auth?: Auth;
  /** Sends password-reset links. Default: MAIL_WEBHOOK_URL when set, otherwise none (links are not sent). */
  mailer?: Mailer;
  /** Inject a job queue (tests). Default: BullMQ when REDIS_URL is set, otherwise in-process. */
  jobs?: JobQueue;
  /** Lab branding and signatures for documents. Default: report-kit's defaultLab() (MGPL_SIGNATURE_* files). */
  lab?: LabProfile;
}

/** The composition root: one database, one auth, one set of services, shared by every request. */
export interface Container {
  config: Config;
  db: Db;
  auth: Auth;
  services: Services;
  /** Background jobs: BullMQ (REDIS_URL; `npm run worker` runs them) or in-process. */
  jobs: JobQueue;
  /** What the worker's processors need (the same services). */
  jobDeps: JobDeps;
  close(): Promise<void>;
}

export async function createContainer(o: ContainerOptions): Promise<Container> {
  const { config } = o;
  const ownsDb = !o.db;
  const db =
    o.db ??
    (await createDb({
      backend: config.db.backend,
      ...(config.db.backend === "pg" ? { pg: { url: config.db.url } } : { mongo: { uri: config.db.url } }),
      redis: config.redisUrl ?? undefined,
      // invoices and payments post to the books through finance-kit → tally-kit
      posting: financePosting,
    } as Parameters<typeof createDb>[0]));

  let auth = o.auth;
  if (!auth) {
    const redis = db.redis;
    const stores = redis
      ? await (async () => {
          const r = await import("@mgpl-diagnostics/auth-kit/redis");
          return {
            sessions: r.redisSessionStore(redis),
            kv: r.redisKeyValueStore(redis),
            limiter: r.redisRateLimiter(redis, { limit: 10, windowMs: 15 * 60_000 }),
          };
        })()
      : { sessions: memorySessionStore(), kv: memoryKeyValueStore(), limiter: memoryRateLimiter({ limit: 10, windowMs: 15 * 60_000 }) };
    // auth reads users on every request: use the raw (uncached) repositories so a disabled user is out at once
    const r = db.rawRepos;
    // JWT mode: short-lived access tokens + single-use refresh tokens (kv), sessions still checked per request
    auth = createAuth({
      users: r.users, orgs: r.orgs, roles: r.roles, audit: r.audit, ...stores, session: config.session,
      jwt: { secret: config.jwt.secrets, issuer: config.jwt.issuer, accessTtlMs: config.jwt.accessTtlMs },
      deviceBinding: config.deviceBinding,
    });
  }

  const mailer = o.mailer ?? (config.mailWebhookUrl ? webhookMailer(config.mailWebhookUrl) : undefined);
  let jobDeps: JobDeps | undefined;
  const jobs =
    o.jobs ??
    (config.redisUrl
      ? createBullJobQueue({ redisUrl: config.redisUrl, prefix: config.jobs.prefix, keepResultsMs: config.jobs.keepResultsMs })
      : createInlineJobQueue(() => jobDeps!, { keepResultsMs: config.jobs.keepResultsMs }));
  const services = createServices({ repos: db.repos, auth, mailer, resetUrl: config.resetUrl, lab: o.lab, samples: config.samples, jobs: () => jobs });
  jobDeps = { repos: db.repos, auth, services };
  return {
    config,
    db,
    auth,
    services,
    jobs,
    jobDeps,
    async close() {
      if (!o.jobs) await jobs.close();
      if (ownsDb) await db.close();
    },
  };
}
