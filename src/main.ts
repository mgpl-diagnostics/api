// Starts the API: `npm run dev` (watch) or `npm run build && npm start`.
import { loadConfig } from "./config/env";
import { createContainer } from "./container";
import { buildServer } from "./server";

const config = loadConfig();
const container = await createContainer({ config });
if (!container.db.redis && config.env === "production") console.warn("[api] REDIS_URL is not set: sessions live in this process only (one server, lost on restart)");
// No mailer is wired in this entry: requestPasswordReset still answers true but sends nothing.
// Embed the API with createContainer({ config, mailer }) to send reset links (docs/12-deployment.md).
if (config.env === "production") console.warn("[api] no Mailer configured: password-reset links are not sent");
const app = await buildServer(container);
await app.listen({ host: config.host, port: config.port });
console.log(`[api] GraphQL on http://${config.host}:${config.port}${config.graphqlPath} (${config.db.backend})`);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    app.close().then(() => process.exit(0), () => process.exit(1));
  });
}
