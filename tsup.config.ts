import { defineConfig } from "tsup";

// The server bundle: our code only; the kits and drivers stay in node_modules.
export default defineConfig({
  entry: { main: "src/main.ts", index: "src/index.ts" },
  format: ["esm"],
  dts: { entry: { index: "src/index.ts" } },
  target: "node20",
  platform: "node",
  clean: true,
  packages: "external",
});
