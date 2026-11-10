import { defineConfig } from "tsup";

// The server bundle: our code only; the kits and drivers stay in node_modules. dist/seed.js lets the
// Docker image create the first lab (`docker compose run --rm db-sync node dist/seed.js`).
export default defineConfig({
  entry: { main: "src/main.ts", worker: "src/worker.ts", sync: "src/sync.ts", seed: "scripts/seed.ts", index: "src/index.ts" },
  format: ["esm"],
  dts: { entry: { index: "src/index.ts" } },
  target: "node20",
  platform: "node",
  clean: true,
  packages: "external",
});
