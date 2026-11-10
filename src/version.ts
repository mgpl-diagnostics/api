import { readFileSync } from "node:fs";

/** This build's version: package.json's, which the release workflow checks against the `v*` tag and the image tag. */
export const VERSION: string = (() => {
  try {
    return (JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string }).version;
  } catch {
    return "0.0.0";
  }
})();
