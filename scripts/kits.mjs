// Builds every @mgpl-diagnostics kit from source into .kits/*.tgz and installs them with this repo's
// dependencies. Needed because not every kit is on GitHub Packages yet (finance-kit), and this repo's
// CI token has no package access yet. See docs/12-local-agent-brief.md for the switch to the registry.
//
//   npm run kits                       # clone each kit at the ref in kits.json (public repos, no token)
//   KITS_SRC=.. npm run kits           # use local checkouts next to this repo instead (their working tree)
//   npm run kits -- --no-install       # only build the tarballs
//
// Each kit is copied to .kits/src/<name>, its @mgpl-diagnostics dependencies are pointed at the
// tarballs built before it, it is built with tsup and packed with its ORIGINAL package.json.
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const out = join(root, ".kits");
const { kits } = JSON.parse(readFileSync(join(root, "kits.json"), "utf8"));
const local = process.env.KITS_SRC ? resolve(root, process.env.KITS_SRC) : null;
const install = !process.argv.includes("--no-install");
const run = (cmd, args, cwd) => execFileSync(cmd, args, { cwd, stdio: ["ignore", "inherit", "inherit"], env: { ...process.env, npm_config_audit: "false", npm_config_fund: "false" } });
const tgz = (name) => join(out, `${name}.tgz`);

rmSync(out, { recursive: true, force: true });
mkdirSync(join(out, "src"), { recursive: true });

for (const { name, ref } of kits) {
  const dir = join(out, "src", name);
  console.log(`\n▶ ${name} (${local ? `local ${join(local, name)}` : ref})`);
  if (local) {
    cpSync(join(local, name), dir, { recursive: true, filter: (p) => !/[\\/](node_modules|dist|\.git)$/.test(p) });
  } else {
    mkdirSync(dir);
    run("git", ["init", "-q"], dir);
    run("git", ["fetch", "-q", "--depth", "1", `https://github.com/mgpl-diagnostics/${name}.git`, ref], dir);
    run("git", ["checkout", "-q", "FETCH_HEAD"], dir);
  }
  const pkgFile = join(dir, "package.json");
  const original = readFileSync(pkgFile, "utf8");
  const pkg = JSON.parse(original);
  // build-time view of the package: our kits come from the tarballs built so far
  for (const field of ["dependencies", "devDependencies", "peerDependencies"]) {
    for (const dep of Object.keys(pkg[field] ?? {})) {
      if (!dep.startsWith("@mgpl-diagnostics/")) continue;
      const file = tgz(dep.split("/")[1]);
      if (!existsSync(file)) throw new Error(`${name} needs ${dep}; list it earlier in kits.json`);
      pkg[field][dep] = `file:${file}`; // same field, so tsup still treats peers as external
    }
  }
  writeFileSync(pkgFile, JSON.stringify(pkg, null, 2));
  run("npm", ["install", "--no-package-lock", "--ignore-scripts", "--loglevel=error"], dir);
  run("npm", ["run", "prepare"], dir);
  writeFileSync(pkgFile, original);
  run("npm", ["pack", "--ignore-scripts", "--silent", "--pack-destination", out], dir);
  const packed = readdirSync(out).find((f) => f.startsWith(`mgpl-diagnostics-${name}-`) && f.endsWith(".tgz"));
  if (!packed) throw new Error(`npm pack produced no tarball for ${name}`);
  cpSync(join(out, packed), tgz(name));
  rmSync(join(out, packed));
}

if (install) {
  console.log("\n▶ installing this repo's dependencies with the kits");
  run("npm", ["install", "--no-package-lock", "--no-save", "--loglevel=error", ...kits.map((k) => tgz(k.name))], root);
}
console.log("\n✓ kits ready");
