# 17 · Scaling: replicas and PgBouncer

The API runs as any number of identical replicas behind a reverse proxy. Every replica connects to
PostgreSQL through **PgBouncer** and keeps nothing per-user in its own memory: sessions, refresh tokens,
login limits and jobs live in **Redis**.

```mermaid
flowchart LR
  U["Browsers / apps"] -- HTTPS --> P["Reverse proxy<br/>(nginx, a load balancer)"]
  P -- "/graphql, /health" --> A1["api #1"] & A2["api #2"] & A3["api #N"]
  A1 & A2 & A3 -- "DB_POOL_MAX each" --> B["PgBouncer<br/>transaction pooling"]
  W["worker(s)"] --> B
  B -- "DEFAULT_POOL_SIZE" --> PG[("PostgreSQL")]
  A1 & A2 & A3 & W --> R[("Redis<br/>sessions · limits · queues · cache")]
  S["db-sync<br/>(once per release)"] -. DDL .-> PG
```

## What each replica needs

| | Why |
|---|---|
| `REDIS_URL`, the same on every replica | Without it sessions, refresh tokens, login limits and jobs live in one process: a token issued by one replica fails on the next, and every replica allows its own 10 login attempts |
| `JWT_SECRET`, the same on every replica | Access tokens are verified locally; a per-process secret (the development default) fails on every other replica |
| `TRUST_PROXY` = the number of proxies in front | Login limits and sessions use the client IP from `X-Forwarded-For`, counted from the right through that many proxies |
| `DB_SYNC=false`, and `node dist/sync.js` once per release | Replicas starting together would race to create the same tables |
| A readiness check on `GET /health`, liveness on `GET /health?live=1` | See below |
| A stop timeout longer than `SHUTDOWN_DRAIN_MS` + `SHUTDOWN_TIMEOUT_MS` | So in-flight requests finish before SIGKILL |

Where the state lives once `REDIS_URL` is set (checked in `src/container.ts` and `src/jobs/`):

| State | Where | Without `REDIS_URL` |
|---|---|---|
| Sessions, refresh tokens, reset tokens (hashed) | Redis (auth-kit `redisSessionStore`, `redisKeyValueStore`) | process memory |
| Login rate limits | Redis (sliding window) | process memory |
| Background jobs and their results | Redis (BullMQ); any worker runs them, any replica reads `job(id)` | process memory |
| db-kit read cache | Redis (L1 per process is off) | none |
| Everything else | PostgreSQL / MongoDB | |
| DataLoader caches | one request only | |

`npm test` proves it: the `[replicas]` checks run two API servers on one PgBouncer and one Redis. A session
started on one works on the other, a refresh token spent on one is refused on the other, a logout on one ends
the session on the other at once, and the login limit is reached after 10 attempts in all, not 10 per replica.

## PgBouncer

Point `DATABASE_URL` at PgBouncer instead of PostgreSQL, e.g. `postgres://USER:PASSWORD@pgbouncer:6432/mgpl`.
Nothing else changes in the API.

**Pool mode: transaction** (recommended). A server connection belongs to a client only for one transaction,
so a few PostgreSQL connections serve many replicas. The API works under it because db-kit (Sequelize on
node-postgres) uses none of the session-level features that break there:

| Feature that breaks under transaction pooling | In db-kit / the API |
|---|---|
| Named prepared statements | Not used: node-postgres sends unnamed statements (extended protocol), which PgBouncer passes through |
| `SET` without `LOCAL` | Only Sequelize's connection setup (`SET client_min_messages`, `SET TIME ZONE '+00:00'`). PgBouncer tracks `TimeZone` and re-applies it per client; `client_min_messages` only changes log noise. Timestamps are `timestamptz`, so values are exact either way |
| Advisory locks, `LISTEN`/`NOTIFY`, temporary tables, `WITH HOLD` cursors | Not used |
| Locks and isolation | `SELECT … FOR UPDATE` and the isolation level live inside `repos.transaction()`, which is one PgBouncer transaction |
| Counters (invoice and voucher numbers) | One `INSERT … ON CONFLICT … RETURNING` statement |

`npm test` runs the whole PostgreSQL suite a second time through PgBouncer in transaction mode (`[pgbouncer]`),
then fires 16 invoices with payments at once from two replicas (2 × `DB_POOL_MAX=4` client connections)
over a 3-connection server pool: all are posted, every number is unique and the trial balance balances.

Session mode also works, but then each client connection holds a server connection, so it saves little.
Statement mode does not work (transactions span several statements).

`DB_SYNC` and `node dist/sync.js` run DDL; they work through PgBouncer, but `docker-compose.yml` points
db-sync straight at PostgreSQL, as migrations usually are.

### Sizing the pools

Two pools in series:

```
API replicas × DB_POOL_MAX  +  workers × DB_POOL_MAX   ≤  PgBouncer max_client_conn
PgBouncer default_pool_size + reserve_pool_size          ≤  max_db_connections  <  PostgreSQL max_connections
```

- `DB_POOL_MAX` (default 10) is per process. Behind PgBouncer these are cheap client connections; it
  caps how many queries one replica runs at once.
- PgBouncer's `default_pool_size` (compose default 20) is what PostgreSQL actually sees. Start near
  2 × the database server's CPU cores and raise it only if clients wait (`SHOW POOLS` → `cl_waiting`).
- Leave PostgreSQL a few connections above PgBouncer's cap for db-sync, backups and an admin `psql`.

Example: 4 replicas + 2 workers × `DB_POOL_MAX=10` = 60 client connections (`max_client_conn` 500 is
plenty); `default_pool_size=20`, `reserve_pool_size=5`, `max_db_connections=50`; PostgreSQL
`max_connections=100`.

**MongoDB** needs no PgBouncer: the driver pools by itself, and `DB_POOL_MAX` / `DB_POOL_MIN` /
`DB_POOL_IDLE_MS` / `DB_POOL_ACQUIRE_MS` set `maxPoolSize`, `minPoolSize`, `maxIdleTimeMS` and
`waitQueueTimeoutMS`. Keep replicas × `DB_POOL_MAX` within the cluster's connection limit.

## Health and readiness

| Request | 200 when | 503 when | Use it for |
|---|---|---|---|
| `GET /health` | the database answers, Redis answers (when configured), and the replica is not shutting down | any of those fails | readiness: the load balancer sends traffic only to replicas that answer 200 |
| `GET /health?live=1` | the process is running | never | liveness: restart a replica only when the process hangs, not when the database is down (that would restart every replica at once) |

The body says which part failed: `{ "ok": false, "database": "ok", "redis": "unreachable" }` or
`{ "ok": false, "draining": true }`. The `{ health }` GraphQL field still reports the database.

## Graceful shutdown

On SIGTERM (or SIGINT) the API (`src/lifecycle.ts`):

1. answers `GET /health` with 503 at once, while it keeps serving every other request;
2. waits `SHUTDOWN_DRAIN_MS` (5 s in production) so the load balancer sees the 503 and stops routing here;
3. stops accepting connections, closes idle keep-alive connections, answers 503 to new requests on open
   ones and waits for the requests in flight;
4. closes the job queue, the database pool and Redis, and exits 0.

A second signal, or `SHUTDOWN_TIMEOUT_MS` (30 s) after the first, exits at once with code 1. The worker
finishes its jobs in hand and stops; after `SHUTDOWN_TIMEOUT_MS` it exits and BullMQ retries the job that
was cut short. Give the orchestrator a longer stop timeout than drain + timeout: `stop_grace_period: 40s`
in compose, `terminationGracePeriodSeconds: 40` in Kubernetes.

Rolling updates then drop nothing: start the new replicas, wait for them to be ready, stop the old ones.
Stopping one replica of three under constant traffic through nginx gave 40 of 40 requests answered 200.

## Docker Compose

[`docker-compose.yml`](../docker-compose.yml) runs the whole backend on one host: PostgreSQL, PgBouncer
(transaction mode), Redis (AOF on), a one-shot `db-sync`, `API_REPLICAS` API containers, a worker and
nginx ([`deploy/nginx.conf`](../deploy/nginx.conf)) in front of the replicas on `HTTP_PORT`.

```bash
cp .env.example .env     # NODE_ENV=production, JWT_SECRET, CORS_ORIGINS, POSTGRES_PASSWORD, SMTP_URL, …
NODE_AUTH_TOKEN=…  docker compose build          # the kits come from GitHub Packages (read:packages)
docker compose up -d                              # http://localhost:8080/graphql
docker compose up -d --scale api=4                # change the number of replicas at any time
docker compose exec -e PGPASSWORD=… postgres psql -h pgbouncer -p 6432 -U postgres pgbouncer -c 'SHOW POOLS'
```

- The API containers get `DATABASE_URL` (PgBouncer), `REDIS_URL`, `DB_SYNC=false` and `TRUST_PROXY=1`
  from the compose file; everything else comes from `.env`.
- nginx re-resolves `api` every 10 s, so scaling needs no restart, and retries a request on another
  replica when one answers 503 or refuses the connection.
- TLS: terminate it in front (a CDN or cloud load balancer, then `TRUST_PROXY=2`) or add a `listen 443 ssl`
  server to `deploy/nginx.conf`.
- Signatures: mount the files read-only into `api` and `worker` and set `MGPL_SIGNATURE_*_FILE`.
- The compose file is PostgreSQL only. For MongoDB, drop `postgres`, `pgbouncer` and `db-sync`, and set
  `DB_BACKEND=mongo`, `DATABASE_URL` (a replica set) and `DB_SYNC` on one replica.

## Kubernetes or another orchestrator

The same pieces map one to one: a Deployment of the image with `replicas: N`, a readiness probe on
`/health`, a liveness probe on `/health?live=1`, `terminationGracePeriodSeconds: 40`; a Job (or an init
step of the release) running `node dist/sync.js`; PgBouncer as its own Deployment and Service (or a managed
pooler such as the provider's PgBouncer); Redis managed or as a StatefulSet; the worker as a second
Deployment with `command: ["node", "dist/worker.js"]`.
