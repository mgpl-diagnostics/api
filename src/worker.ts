// Starts the background worker: `npm run worker:dev` (watch) or `npm run build && npm run worker`.
// Same configuration as the API; REDIS_URL is required. Run as many workers as you like.
import { loadConfig } from "./config/env";
import { createContainer } from "./container";
import { startWorkers } from "./jobs";

const config = loadConfig();
if (!config.redisUrl) {
  console.error("[worker] REDIS_URL is required: the worker takes its jobs from Redis (BullMQ)");
  process.exit(1);
}
if (config.env === "production" && !config.smtp && !config.mailWebhookUrl) console.warn("[worker] neither SMTP_URL nor MAIL_WEBHOOK_URL is set: password-reset links are not sent");
const container = await createContainer({ config });
const workers = startWorkers(container.jobDeps, { redisUrl: config.redisUrl, prefix: config.jobs.prefix, keepResultsMs: config.jobs.keepResultsMs, concurrency: config.jobs.concurrency });
console.log(`[worker] queues ${workers.workers.map((w) => w.name).join(", ")} on ${config.jobs.prefix}: (concurrency ${config.jobs.concurrency}, ${config.db.backend})`);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    // finish the jobs in hand, then stop
    workers.close().then(() => container.close()).then(() => process.exit(0), () => process.exit(1));
  });
}
