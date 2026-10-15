# 02 · Architecture

## Layers

Each layer talks only to the one below it. Controllers never touch the database directly except through
the per-request loaders; services never see GraphQL.

```mermaid
flowchart TB
  subgraph HTTP["HTTP · src/server.ts"]
    F["Fastify<br/>POST /graphql · GET /health"]
    Y["GraphQL Yoga<br/>CORS · masked errors · depth limit 12 · introspection switch"]
  end
  subgraph GQL["GraphQL · src/graphql + src/schema"]
    SDL["SDL per module<br/>src/schema/*.graphql.ts"]
    CTX["Request context<br/>viewer · can() · loaders"]
  end
  subgraph CTRL["Controllers · src/controllers"]
    C["Resolvers<br/>authorize() · map enums · call services"]
  end
  subgraph SRV["Services · src/services"]
    S["Business calls<br/>(actor, input) → kits"]
  end
  subgraph KITS["Kits (internal libraries)"]
    K1["auth-kit"]
    K2["db-kit"]
    K3["catalog-kit"]
    K4["report-kit · invoice-kit"]
    K5["tally-kit · finance-kit"]
  end
  DB[("PostgreSQL / MongoDB")]
  RD[("Redis (optional)")]
  subgraph JOBS["Jobs · src/jobs"]
    Q["JobQueue<br/>BullMQ on Redis, or in-process"]
    W["Worker · src/worker.ts<br/>processors → the same services"]
  end
  F --> Y --> SDL --> C
  Y --> CTX --> C
  C --> S --> KITS
  S --> Q
  Q -.-> RD
  RD -.-> W
  W --> S
  K2 --> DB
  K1 -.-> RD
  K2 -.-> RD
```

| Layer | Folder | Does | Does not |
|---|---|---|---|
| Server | `src/server.ts`, `src/main.ts` | Fastify, Yoga, `/health`, shutdown | Business logic |
| Worker | `src/worker.ts` | BullMQ workers on Redis, shutdown | HTTP |
| Jobs | `src/jobs/` | Queue (BullMQ or in-process), job payloads, processors that call services, the webhook mailer | Permissions (checked before queueing) |
| Schema | `src/schema/` | SDL, one file per module | Code |
| GraphQL plumbing | `src/graphql/` | Context, guards, errors, scalars, loaders, limits, schema assembly | Domain rules |
| Controllers | `src/controllers/` | Permissions, argument mapping, nested fields | Database writes |
| Services | `src/services/` | Calls into the kits with `(actor, input)`, transactions, ownership checks | GraphQL types or errors |
| Container | `src/container.ts` | Builds db, auth and services once per process | Per-request state |
| Config | `src/config/env.ts` | Reads and checks environment variables | Defaults that are unsafe in production |

## Folders

```
src/
  main.ts               start: loadConfig → createContainer → buildServer → listen; SIGINT/SIGTERM close
  worker.ts             start the worker: loadConfig → createContainer → startWorkers (needs REDIS_URL)
  server.ts             Fastify + Yoga (one endpoint) + GET /health
  container.ts          createDb (posting: financePosting), createAuth (JWT mode; Redis or memory stores), job queue, services
  index.ts              library entry (buildServer, createContainer, buildSchema, … for tests and embedding)
  config/env.ts         loadConfig(env) → Config
  graphql/
    schema.ts           MODULES (typeDefs + resolvers per module) → buildSchema()
    context.ts          RequestContext, createContext (bearer token → auth-kit context)
    guards.ts           actorOf, authorize, canSee, branchScope, cap
    errors.ts           ERROR_CODES, toGraphQLError, withErrorCodes
    scalars.ts          DateTime, Day, JSON
    loaders.ts          per-request BatchLoader per entity (no N+1)
    limits.ts           depthLimit
    device.ts           DeviceInput → auth-kit DeviceSignals (moves to security-kit later)
  jobs/
    types.ts            QUEUES, job payloads, JobInfo, JobQueue, JobFailure
    processors.ts       password-reset, document rendering (call services)
    bullmq.ts           createBullJobQueue (producer), startWorkers (consumer)
    inline.ts           createInlineJobQueue (no Redis: runs at once in this process)
    mailer.ts           webhookMailer (MAIL_WEBHOOK_URL)
  schema/<module>.graphql.ts      SDL
  controllers/<module>.controller.ts
  services/<area>.service.ts, index.ts (createServices), util.ts
scripts/                kits.mjs, seed.ts, print-schema.ts, api-reference.ts, llms-full.mjs
test/run.ts             end-to-end suite over HTTP (app.inject)
schema.graphql          the printed schema (CI checks it is current)
kits.json               which kit versions CI builds (see 11-testing.md)
```

Modules: `base`, `auth`, `organization`, `catalog`, `lab`, `billing`, `books`, `finance`, `documents`.

## A request, end to end

```mermaid
sequenceDiagram
  autonumber
  participant Cl as Client
  participant Fa as Fastify
  participant Yo as Yoga
  participant Cx as createContext
  participant Au as auth-kit
  participant Ct as Controller
  participant Sv as Service
  participant Kt as db-kit / finance-kit
  participant DB as Database
  Cl->>Fa: POST /graphql (Authorization: Bearer access JWT)
  Fa->>Yo: handleNodeRequestAndResponse
  Yo->>Yo: parse, validate (depth ≤ 12, introspection rule)
  Yo->>Cx: build context
  Cx->>Au: context(t) → verifies the JWT, checks the session, re-reads the user
  Au-->>Cx: viewer, can(), branchesFor()
  Yo->>Ct: resolve issueInvoice(input)
  Ct->>Ct: authorize(ctx, "invoice:create", input.branchId)
  Ct->>Sv: billing.issue(actor, input)
  Sv->>Kt: issueInvoice(repos, …) inside repos.transaction()
  Kt->>DB: invoice + voucher (posting hook) atomically
  DB-->>Kt: ok
  Kt-->>Sv: Invoice
  Sv-->>Ct: Invoice
  Ct-->>Yo: Invoice (nested fields via loaders)
  Yo-->>Cl: { data: { issueInvoice: … } }
```

If anything throws, `withErrorCodes` turns domain errors (from db-kit, auth-kit, finance-kit,
report-kit) into GraphQL errors with a code; any other error is masked as "Unexpected error"
([05-errors.md](05-errors.md)).

## How the kits depend on each other

```mermaid
flowchart LR
  API["api"] --> AUTH["auth-kit"]
  API --> DB["db-kit"]
  API --> CAT["catalog-kit"]
  API --> INV["invoice-kit"]
  API --> REP["report-kit"]
  API --> FIN["finance-kit"]
  API --> TAL["tally-kit"]
  INV --> REP
  FIN --> TAL
  FIN --> DB
  TAL --> DB
  DB -. "stores users for" .-> AUTH
  CL["client (frontend)"] -. "POST /graphql" .-> API
```

- db-kit's repositories satisfy auth-kit's store interfaces (users, orgs, roles, audit), so auth-kit reads
  and writes users through db-kit (`container.ts` passes `db.rawRepos`).
- db-kit posts billing to the books through a `PostingHook`. The API sets it to finance-kit's
  `financePosting`, which posts through tally-kit with GST split by place of supply.
- `src/graphql` in db-kit is an older, partial GraphQL layer. This API replaces it; db-kit will remove
  it in a major version ([LOCAL-AGENT-BRIEF.md](LOCAL-AGENT-BRIEF.md)).

## The container

```mermaid
flowchart LR
  ENV["process.env"] --> CFG["loadConfig()"]
  CFG --> CON["createContainer()"]
  CON --> DBX["createDb({ backend, url, redis?, posting: financePosting })"]
  CON --> AUX["createAuth({ users, orgs, roles, audit from db,<br/>sessions/kv/limiter from Redis or memory, jwt, deviceBinding })"]
  CON --> JQ["job queue: BullMQ (REDIS_URL) or in-process"]
  CON --> SVX["createServices(db.repos, auth, mailer, lab, jobs)"]
  CON -. "jobDeps" .-> WK["startWorkers (src/worker.ts)"]
  CON --> SRV["buildServer(container)"]
```

One container per process. Tests build it with an embedded database and a capturing mailer; production
builds it from the environment. `close()` closes what the container opened.

## Cross-cutting rules

1. **Tenant isolation.** Services take an `Actor { userId, orgId }` from the session. `mustOwn` / `owned`
   check that a record's `orgId` matches before anything is returned or changed.
2. **Branch scoping.** `authorize(ctx, perm, branchId)` checks the record's own branch; list queries use
   `branchScope`, which narrows to the branches where the user holds the permission.
3. **Transactions.** Multi-record writes run in `repos.transaction()` inside the kits.
4. **No N+1.** Nested fields (`Booking.patient`, `Invoice.branch`, …) go through per-request loaders.
5. **Limits.** Query depth ≤ 12, list `limit` ≤ 200, request body ≤ 2 MB by default.
