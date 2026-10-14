# AGENTS.md — @mgpl-diagnostics/api

The MGPL Diagnostics backend: **one GraphQL endpoint** (`POST /graphql`, GraphQL Yoga on Fastify) over
the kits, used as internal libraries. Read [docs/README.md](docs/README.md) for the full picture and
[docs/13-adding-a-feature.md](docs/13-adding-a-feature.md) before adding anything.

## Map

```
src/main.ts            start (config → container → server)
src/server.ts          Fastify + Yoga + GET /health (no other routes)
src/container.ts       createDb (posting: financePosting) + createAuth + services, once per process
src/config/env.ts      loadConfig: every environment variable
src/graphql/           schema.ts (MODULES → buildSchema), context, guards, errors, scalars, loaders, limits
src/schema/            SDL per module: base auth organization catalog lab billing books finance documents
src/controllers/       resolvers per module: authorize → map → service
src/services/          business calls on the kits: (actor, input), ownership checks, no GraphQL
scripts/               kits.mjs (build kits from source), seed.ts, print-schema.ts, api-reference.ts, llms-full.mjs
test/run.ts            end-to-end over HTTP on PostgreSQL + MongoDB, plus docs/examples validation
docs/                  A-to-Z docs (Mermaid), examples/*.graphql, LOCAL-AGENT-BRIEF.md
schema.graphql         printed schema (generated)
kits.json              kit refs for `npm run kits`
```

## Rules

1. **One endpoint.** Everything is a GraphQL field. No REST routes besides `GET /health`; documents
   travel as `Document { base64 | html }`, exports as `CsvFile`.
2. **Layers.** Schema → controller → service → kit. Controllers check permissions and map; services hold
   the logic and never import GraphQL; storage changes go to db-kit, finance rules to finance-kit,
   posting to tally-kit, permissions to auth-kit, catalog data to catalog-kit, layouts to report-kit /
   invoice-kit.
3. **Tenant isolation.** No argument carries an `orgId` or `actorId`. They come from the session
   (`actorOf`). Every id is checked against the organisation (`mustOwn`, `owned`, `scopedFind`).
4. **Permissions per branch.** Load a record, then `authorize(ctx, perm, record.branchId)`; lists use
   `branchScope`. Every permission must exist in auth-kit's `PERMISSIONS`.
5. **Errors.** Wrap controllers in `withErrorCodes`. Never build a `GraphQLError` with `originalError`
   (Yoga masks it). Error codes are a public contract: add, never rename.
6. **Money is integer paise; days are IST `Day` strings; the financial year is April–March.**
7. **No N+1.** Nested fields go through `ctx.loaders`. Lists are capped with `cap()` (≤ 200).
8. **Both databases.** Tests run on PostgreSQL and MongoDB; a change must pass on both.
9. **Generated files stay current** (CI checks): `npm run schema`, `npm run docs:reference`, `npm run llms`.
10. **Client contract.** `@mgpl-diagnostics/client` mirrors the schema; when a field is added or renamed,
    update the client (operations, types, method, docs) and bump its ref in `kits.json`.
11. **Compliance values are configuration** verified by the lab's CA (`verifyWithCA`). Ask the owner
    before changing one. No doctor referral commissions.
12. Never commit patient data, signatures, secrets or `.env` files. Test fixtures use fictional names.

## Commands

```bash
npm run kits                       # once, and after changing kits.json
npm run typecheck && npm test && npm run build
npm run schema && npm run docs:reference && npm run llms
```

`npm test` downloads PostgreSQL and MongoDB binaries on first run. Behind a proxy that blocks MongoDB,
set `MONGOMS_SYSTEM_BINARY` or run `TEST_BACKENDS=pg npm test` (CI still runs both).

## Repository rules

`main` takes pull requests only: squash merge, 1 code-owner review (`@BackStacked`), the `ci` check
required. Rules come from `mgpl-diagnostics/.github` (`scripts/protect-repos.mjs`).

## Licence

All rights reserved (see LICENSE).
