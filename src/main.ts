// Starts the API: `npm run dev` (watch) or `npm run build && npm start`.
import { loadConfig } from "./config/env";
import { createContainer } from "./container";
import { buildServer } from "./server";

const config = loadConfig();
const container = await createContainer({ config });
if (config.env === "production" && !config.redisUrl) console.warn("[api] REDIS_URL is not set: sessions and jobs live in this process only (one server, lost on restart)");
if (config.jwt.generated) console.warn("[api] JWT_SECRET is not set: using a random secret, so tokens die when the process restarts");
// With REDIS_URL, emails and background documents are sent and rendered by `npm run worker`.
// Without it they run here; reset links go to MAIL_WEBHOOK_URL (or createContainer({ config, mailer })).
if (config.env === "production" && !config.redisUrl && !config.mailWebhookUrl) console.warn("[api] no Mailer configured: password-reset links are not sent");
const app = await buildServer(container);
await app.listen({ host: config.host, port: config.port });
console.log(`[api] GraphQL on http://${config.host}:${config.port}${config.graphqlPath} (${config.db.backend})`);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    app.close().then(() => process.exit(0), () => process.exit(1));
  });
}
