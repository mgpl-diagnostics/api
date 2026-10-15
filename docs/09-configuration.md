# 09 · Configuration

All configuration comes from environment variables, read once by `loadConfig()` (`src/config/env.ts`).
[`.env.example`](../.env.example) lists every one of them, grouped by area, with what it does, whether it
is required in production and whether it is a secret. Copy it to `.env` (git-ignored; never commit it).
`npm run dev`, `npm start`, `npm run worker` and `npm run seed` load `.env` from the working directory;
variables already set in the real environment win over the file.

**Where mail is configured:** `SMTP_URL` (`smtps://user:pass@host:465` or `smtp://user:pass@host:587`) and
`MAIL_FROM`. See [Sending password-reset emails](12-deployment.md#sending-password-reset-emails).

| Variable | Default | Notes |
|---|---|---|
| `NODE_ENV` | `development` | `production` turns off GraphiQL, introspection, samples and `*` CORS by default |
| `HOST` | `0.0.0.0` | |
| `PORT` | `4000` | |
| `GRAPHQL_PATH` | `/graphql` | The one endpoint |
| `DB_BACKEND` | `pg` | `pg` or `mongo` |
| `DATABASE_URL` | local default in development; **required** in production | Postgres URL, or a MongoDB URI with `replicaSet=` |
| `DB_POOL_MAX` | `10` | Connections this process keeps open (Sequelize pool / MongoDB driver pool), per API server and worker. Behind PgBouncer: (replicas + workers) × this ≤ PgBouncer's `max_client_conn` ([17-scaling.md](17-scaling.md#sizing-the-pools)) |
| `DB_POOL_MIN` | `0` | Connections kept open when idle |
| `DB_POOL_IDLE_MS` | `10000` | Close a pooled connection after this long idle |
| `DB_POOL_ACQUIRE_MS` | `30000` | A query that waited this long for a free connection fails |
| `DB_SYNC` | `true` | Create missing tables / indexes on start. `false` on every replica when several run, with `npm run db:sync` once per release |
| `REDIS_URL` | empty | Sessions, refresh tokens, login limits, db-kit's read cache and the job queues (BullMQ). Required for more than one server and for the worker |
| `CORS_ORIGINS` | `*` in development, empty in production | Comma-separated origins. `*` is refused in production |
| `GRAPHIQL` | on in development | GraphiQL at the endpoint (GET) |
| `INTROSPECTION` | on in development | Off adds `NoSchemaIntrospectionCustomRule` |
| `BODY_LIMIT_BYTES` | `2000000` | Request body limit (bank CSV imports count) |
| `TRUST_PROXY` | `false` | How many proxies in front of the API append to `X-Forwarded-For`: `true` = 1 (a load balancer), `2` for CDN + load balancer. Login limits and sessions then see the client IP; entries left of the trusted proxies (which any client can send) are ignored |
| `MGPL_SAMPLES` | on in development | Demo report/invoice samples in `documents` |
| `SESSION_IDLE_MS` | `43200000` (12 h) | |
| `SESSION_MAX_AGE_MS` | `2592000000` (30 days) | |
| `PASSWORD_RESET_URL` | empty (`/reset-password`) | The page that receives `?token=` |
| `JWT_SECRET` | random per process in development; **required** in production | Signs access tokens. ≥ 32 characters; `new,old` to rotate |
| `JWT_ISSUER` | `mgpl-api` | `iss` claim, checked on every request |
| `ACCESS_TOKEN_TTL_MS` | `900000` (15 min) | Access-token lifetime |
| `DEVICE_BINDING` | `enforce` | Refresh from another device: `enforce` ends the session, `flag` audits, `off` ignores |
| `QUEUE_PREFIX` | `mgpl` | BullMQ key prefix ([16-worker.md](16-worker.md)) |
| `WORKER_CONCURRENCY` | `4` | Jobs per worker at once, per queue |
| `JOB_RESULT_TTL_MS` | `3600000` (1 h) | How long finished jobs and their documents stay readable |
| `SMTP_URL` | empty | Mail through mail-kit: `smtps://user:pass@host:465` (TLS) or `smtp://user:pass@host:587` (STARTTLS). Preferred over `MAIL_WEBHOOK_URL` |
| `MAIL_FROM` | — (required with `SMTP_URL` in production) | Sender, e.g. `Maa Gayatri Path Lab <no-reply@your-domain>` |
| `MAIL_WEBHOOK_URL` | empty | Email relay for reset links when `SMTP_URL` is not set: POST `{ to, subject, text }` |
| `MGPL_SIGNATURE_HEADER_FILE` | — | PNG for the header variant (outside the repo) |
| `MGPL_SIGNATURE_NONHEADER_FILE` | — | PNG for the non-header variant |
| `MGPL_SIGNATURE_FILE` | — | One file for both |
| `SHUTDOWN_DRAIN_MS` | `5000` in production, `0` otherwise | On SIGTERM, `GET /health` answers 503 this long while requests are still served ([17-scaling.md](17-scaling.md#graceful-shutdown)) |
| `SHUTDOWN_TIMEOUT_MS` | `30000` | Exit anyway this long after the signal (API and worker) |

`docker-compose.yml` reads a few more from `.env` (not the API): `API_REPLICAS`, `HTTP_PORT`,
`POSTGRES_PASSWORD`, `POSTGRES_MAX_CONNECTIONS` and the `PGBOUNCER_*` pool settings
([17-scaling.md](17-scaling.md#docker-compose)).

Seed-only variables (`npm run seed`): `SEED_ORG_NAME`, `SEED_ORG_CODE`, `SEED_ORG_GSTIN` (optional),
`SEED_BRANCH_CODE`, `SEED_BRANCH_NAME`, `SEED_BRANCH_STATE`, `SEED_OWNER_NAME`, `SEED_OWNER_EMAIL`,
`SEED_OWNER_PASSWORD`.

Test-only: `TEST_BACKENDS=pg,mongo` (default both), `DEBUG=1` prints resolver errors,
`MONGOMS_SYSTEM_BINARY` points mongodb-memory-server at a local `mongod`, `PGBOUNCER_BIN` the `pgbouncer`
binary for the PgBouncer and replica checks.

## Finance configuration

GST and TDS values are not environment variables. They are data in the organisation's settings
(`settings.finance`, merged over finance-kit's `DEFAULT_FINANCE_CONFIG`) and tax rules (`taxRules`,
`addTaxRule`, `seedTaxRules`). Every value the CA must confirm is listed by `verifyWithCA`.

```mermaid
flowchart LR
  D["finance-kit DEFAULT_FINANCE_CONFIG"] --> MRG["merged config<br/>(financeConfig query)"]
  O["organization.settings.finance"] --> MRG
  TR["taxRules (per org)"] --> GST["GST per invoice line"]
  MRG --> GST
  MRG --> TDS["TDS on settlements"]
```
