// Creates the first organisation, its first branch, the owner account, auth-kit's system roles and
// the chart of accounts. Run once per new database:
//   SEED_ORG_NAME="Maa Gayatri Path Lab" SEED_ORG_CODE=MGPL SEED_BRANCH_CODE=ARG01 SEED_BRANCH_NAME=Arang \
//   SEED_BRANCH_STATE=22 SEED_OWNER_NAME="…" SEED_OWNER_EMAIL=… SEED_OWNER_PASSWORD=… npm run seed
// The password is read from the environment and never printed. Change it after the first sign-in.
import { assertPasswordPolicy, hashPassword, SYSTEM_ROLES } from "@mgpl-diagnostics/auth-kit";
import { createDb, seedOrganization } from "@mgpl-diagnostics/db-kit";
import { financePosting, seedFinanceLedgers } from "@mgpl-diagnostics/finance-kit";
import { loadConfig } from "../src/config/env";

const need = (k: string) => {
  const v = process.env[k]?.trim();
  if (!v) throw new Error(`Set ${k}`);
  return v;
};

const config = loadConfig();
const org = { name: need("SEED_ORG_NAME"), code: need("SEED_ORG_CODE").toUpperCase(), gstin: process.env.SEED_ORG_GSTIN || undefined };
const branch = { code: need("SEED_BRANCH_CODE").toUpperCase(), name: need("SEED_BRANCH_NAME"), stateCode: need("SEED_BRANCH_STATE") };
const owner = { name: need("SEED_OWNER_NAME"), email: need("SEED_OWNER_EMAIL"), password: need("SEED_OWNER_PASSWORD") };
assertPasswordPolicy(owner.password, { email: owner.email, name: owner.name });

const db = await createDb({
  backend: config.db.backend,
  ...(config.db.backend === "pg" ? { pg: { url: config.db.url } } : { mongo: { uri: config.db.url } }),
  posting: financePosting,
} as Parameters<typeof createDb>[0]);
try {
  if (await db.rawRepos.orgs.findOne({ code: org.code })) throw new Error(`Organisation ${org.code} already exists`);
  const seeded = await seedOrganization(db.rawRepos, {
    org,
    branch,
    owner: { name: owner.name, email: owner.email, passwordHash: await hashPassword(owner.password) },
    roles: SYSTEM_ROLES,
  });
  const ledgers = await seedFinanceLedgers(db.rawRepos, seeded.org.id);
  console.log(`Organisation ${seeded.org.code} (${seeded.org.id}), branch ${seeded.branch.code}, owner ${seeded.owner.email}, ${ledgers.length} ledgers.`);
} finally {
  await db.close();
}
