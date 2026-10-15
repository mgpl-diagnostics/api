# Brief for the local agent: what to do outside this repo

**Audience:** an AI agent (Claude Code or similar) or a developer working on the owner's machine with
an org-owner GitHub login (`gh auth status`), Node 22, and Docker or local databases.
**Why local:** the cloud session that built this API could not create releases or tags (403), change org
settings, or download MongoDB binaries. Everything below needs one of those.
**Written:** 2026-10-14, when `mgpl-diagnostics/api` was first published.

Work top to bottom. Each step says how to check it is done. Report back with the checklist at the end.

```mermaid
flowchart TD
  A["1 · Protect the api repo"] --> B["2 · Run the Mongo tests locally"]
  B --> C["3 · Release client 1.1.0"]
  C --> D["4 · Publish finance-kit 1.0.0"]
  D --> E{"5 · ledger-kit name<br/>confirmed by owner?"}
  E -- yes --> F["publish ledger-kit"]
  E -- no --> G["leave unpublished"]
  F & G --> H["6 · Package access for api's Actions"]
  H --> I["7 · Switch api CI to the registry"]
  I --> J["8 · db-kit 2.0.0: remove src/graphql"]
  J --> K["9 · Deploy + seed"]
  K --> L["10 · CA review"]
  L --> M["11 · Tokens, worker, device binding"]
```

## Ground rules

- `main` in every repo takes pull requests only (squash, 1 code-owner review by `@BackStacked`, the
  `ci` check). Never push to `main`; never force-push someone else's branch.
- Release tags `v*` are admin-only and publish packages (`publish.yml`). Bump the version in a PR first,
  merge it, then tag the merge commit.
- Never commit real patient data, signatures, `.env` files or tokens.
- **Ask the owner before changing any value marked "verify with CA"** (GST rates, TDS sections and
  rates, thresholds).
- **Do not release ledger-kit until the owner confirms its final package name** ("Tally" is a trademark).

## 1. Protect the api repo

In `mgpl-diagnostics/.github`, `scripts/protect-repos.mjs` lists required checks per repo in `CHECKS`.
Add `api: ["ci"]` (a PR from the cloud session may already do this; check first), merge, then:

```bash
cd .github && node scripts/protect-repos.mjs api
```

Done when: `gh api repos/mgpl-diagnostics/api/rulesets` lists "main" and "release tags", and a direct
push to `api/main` is refused.

## 2. Run the full test suite with MongoDB

The cloud session ran the api's tests on PostgreSQL only (MongoDB downloads were blocked); CI runs both.
Confirm locally:

```bash
git clone https://github.com/mgpl-diagnostics/api && cd api
npm run kits
npm test                                   # both backends; first run downloads mongod and postgres
# behind a proxy: MONGOMS_SYSTEM_BINARY=$(which mongod) npm test
```

Done when: `… passed, 0 failed` with both `[pg]` and `[mongo]` sections. If Mongo fails and Postgres
passes, the bug is backend-specific: reproduce it in db-kit's contract suite and fix it there (rule 1 of
db-kit's AGENTS.md: both backends behave identically).

## 3. Release client 1.1.0

The GraphQL client (`createMgplGraphQLClient`) was merged with version `1.1.0` in package.json.

```bash
cd client && git checkout main && git pull
git tag v1.1.0 && git push origin v1.1.0        # publish.yml publishes to GitHub Packages
```

Done when: `npm view @mgpl-diagnostics/client@1.1.0 --registry https://npm.pkg.github.com` works.

## 4. Publish finance-kit 1.0.0

finance-kit has no tag yet. Its package.json says `1.0.0`.

```bash
cd finance-kit && git checkout main && git pull && npm run typecheck && npm test && npm run build
git tag v1.0.0 && git push origin v1.0.0
```

Done when: the publish workflow is green and the package is visible in the org's packages.

## 5. ledger-kit: name, then publish

> **Done 2026-10-15.** The owner chose **ledger-kit** (formerly tally-kit). The repo was renamed and
> `@mgpl-diagnostics/ledger-kit@0.1.0` published; finance-kit 1.0.0 and the api depend on it.

Ask the owner to confirm the final package name (ledger-kit's AGENTS.md rule 7). Only then, tag
`v0.1.0` (or the renamed package) and publish. If the name changes, update every `@mgpl-diagnostics/ledger-kit`
import and dependency (finance-kit, api) in one coordinated set of PRs.

## 6. Give the api repo access to the packages

For each package (auth-kit, catalog-kit, db-kit, report-kit, invoice-kit, client, finance-kit,
ledger-kit): GitHub → org → Packages → the package → Package settings → **Manage Actions access** → add
`mgpl-diagnostics/api` with **Read**. (Alternatively make the packages public.)

Done when: a workflow in api can `npm install` them with `GITHUB_TOKEN`.

## 7. Switch api CI from source builds to the registry

Today `npm run kits` (scripts/kits.mjs) clones each kit at the ref in `kits.json` and builds it, because
the packages were not all published or readable. After steps 3–6:

1. In `api/.github/workflows/ci.yml`: replace `npm run kits` with
   ```yaml
   - uses: actions/setup-node@v7
     with: { node-version: 22, registry-url: https://npm.pkg.github.com, scope: "@mgpl-diagnostics" }
   - run: npm install
     env: { NODE_AUTH_TOKEN: "${{ secrets.GITHUB_TOKEN }}" }
   ```
   and add `packages: read` to the workflow `permissions`.
2. Add `"@mgpl-diagnostics/client": "^1.1.0"` to api's devDependencies (today `npm run kits` installs it without saving), so the client contract test
   uses the released client.
3. Commit a `package-lock.json` (`npm install` with the registry configured).
4. Keep `scripts/kits.mjs` and `kits.json` for building unreleased kit branches locally (`KITS_SRC`).
5. Update docs/03-getting-started.md and docs/11-testing.md (they describe `npm run kits` as the default).

Done when: api CI is green with the registry install.

## 8. db-kit 2.0.0: remove the old GraphQL layer

db-kit still carries `src/graphql/` and the `./graphql` export (see db-kit
`docs/MOVE-GRAPHQL-TO-BACKEND.md`). The api replaces it. Removing an export is a breaking change:

1. db-kit PR: delete `src/graphql/`, the `./graphql` export and entry, its tests and graphql peer
   dependencies; update README / AGENTS.md / llms; mark the handoff doc "done (moved to mgpl-diagnostics/api)";
   version `2.0.0`.
2. Before tagging, widen the peer ranges in **finance-kit** and **ledger-kit** to
   `"@mgpl-diagnostics/db-kit": "^1.1.0 || ^2.0.0"` (PRs, with their tests green against 2.0.0).
3. Tag db-kit `v2.0.0`; release finance-kit/ledger-kit patch versions with the widened ranges.
4. Bump api to `^2.0.0` and run its tests on both backends.

Done when: no repo imports `@mgpl-diagnostics/db-kit/graphql` (`gh search code "db-kit/graphql" --owner mgpl-diagnostics`).

## 9. Deploy and seed

Follow [12-deployment.md](12-deployment.md). In particular:

- `REDIS_URL` for more than one server; `CORS_ORIGINS` set to the app origins; `TRUST_PROXY=true`.
- Real signature images in a secret volume, `MGPL_SIGNATURE_HEADER_FILE` / `MGPL_SIGNATURE_NONHEADER_FILE`.
  Never commit them.
- `JWT_SECRET` from your secret store (≥ 32 random characters: `openssl rand -base64 48`), the same on every API server and worker.
- Run at least one worker: `node dist/worker.js` with `REDIS_URL` and the API's environment.
- `SMTP_URL` + `MAIL_FROM` (mail-kit sends over SMTP) for password-reset links, and `PASSWORD_RESET_URL`.
- `npm run seed` once, with the branch's GST state code (`SEED_BRANCH_STATE`, 22 for Chhattisgarh) and
  the organisation's GSTIN (`SEED_ORG_GSTIN`); billing needs the first, GST returns the second.
- Add every other branch with `createBranch` **including its `stateCode`**.

Done when: `GET /health` → 200, an owner can sign in, issue an invoice, and print it.

## 10. CA review (owner + CA, not the agent)

Call `verifyWithCA` and `taxRules` after `seedTaxRules`, and give the list to the lab's chartered
accountant. The agent records answers only as the owner instructs (`addTaxRule`, `settings.finance`);
it never picks rates itself. finance-kit's `docs/gst-notes.md` explains each item.

## 11. Tokens, worker, device binding

Added after the first release (auth-kit 1.2.0, client 1.2.0, api with JWT and the worker).

- **Tag the releases.** auth-kit: bump nothing (package.json already says 1.2.0), tag `v1.2.0` on
  `main`'s head. client: tag `v1.2.0` on `main`'s head. Done when both appear on GitHub Packages.
  Then, in step 7, point `kits.json` / `package.json` at those versions.
- **Redis in production** is now required for more than one server *and* for the worker. Create it
  with AOF persistence if queued emails must survive a restart.
- **Run the worker** next to the API (same image, command `node dist/worker.js`), at least one, with
  `WORKER_CONCURRENCY` sized to the CPU (rendering is CPU-bound). Check its log line
  `[worker] queues mail, documents on mgpl:`.
- **Email.** Set `SMTP_URL` (e.g. `smtps://user:app-password@smtp.example.com:465`) and `MAIL_FROM`;
  mail-kit sends the mails. The provider's SPF/DKIM must cover the sending domain. Done when "Forgot
  password" delivers a link.
- **Secret rotation drill.** Set `JWT_SECRET=new,old`, deploy, wait 15 minutes, set `JWT_SECRET=new`.
- **Device binding** is `enforce` by default. If staff share browsers or wipe storage often and get
  signed out, switch to `DEVICE_BINDING=flag` and read the `auth.device_mismatch` audit entries first.
- **Privacy notice.** The client sends device signals (list in the client's `docs/session.md`); add
  them to the lab's privacy notice before going live.
- **security-kit.** The device-signal code is self-contained (`client/src/graphql/device.ts`,
  `api/src/graphql/device.ts`, auth-kit's `cleanDeviceSignals`) so it can move to security-kit.

Done when: a login survives an access-token expiry without the user noticing, a reset email arrives,
and `startDocumentJob` completes with a worker running.

## Report back

Post one message with:

```
1 protect api ............ done / blocked: …
2 tests on Mongo ......... done (N passed) / failing: …
3 client v1.1.0 .......... done / …
4 finance-kit v1.0.0 ..... done / …
5 ledger-kit name ......... confirmed "<name>" + published / waiting on owner
6 package access ......... done / …
7 api CI on registry ..... PR <link>, green / …
8 db-kit 2.0.0 ........... PRs <links> / not started
9 deploy + seed .......... done at <url> / not started
10 CA review ............. handed to owner / …
11 tokens + worker ....... tags v1.2.0 (auth-kit, client) · worker running · reset email arrives / …
```
