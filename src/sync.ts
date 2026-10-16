// Creates missing tables (PostgreSQL) or indexes (MongoDB), then exits: `npm run db:sync` or `node dist/sync.js`.
// With several API replicas, run this once per release and start the replicas with DB_SYNC=false, so they do
// not all race to create the same tables at once (docs/17-scaling.md). Point DATABASE_URL straight at the
// database for it (DDL does not need PgBouncer); it never alters or drops an existing table.
import { createDb } from "@mgpl-diagnostics/db-kit";
import { financePosting } from "@mgpl-diagnostics/finance-kit";
import { loadConfig, loadEnvFile } from "./config/env";

loadEnvFile();
const config = loadConfig();
const db = await createDb({
  backend: config.db.backend,
  ...(config.db.backend === "pg" ? { pg: { url: config.db.url, options: { pool: { max: 1 } } } } : { mongo: { uri: config.db.url } }),
  posting: financePosting,
  sync: true,
} as Parameters<typeof createDb>[0]);
await db.close();
console.log(`[sync] ${config.db.backend}: tables and indexes are in place`);
