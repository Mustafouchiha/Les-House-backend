// Runs after every `npm install` / `yarn install`.
//  - always: prisma generate (needs the schema, which is always present)
//  - if the TS sources are present: compile to dist/  (so PaaS Node runtimes that
//    only run the install step still get a runnable dist/server.js)
// In the Docker "deps" stage the sources aren't copied yet, so tsc is skipped
// there and the explicit `npm run build` in the build stage does it instead.
import { execSync } from "node:child_process";
import { existsSync } from "node:fs";

function run(cmd) {
  console.log(`[postinstall] ${cmd}`);
  execSync(cmd, { stdio: "inherit" });
}

run("prisma generate");

if (existsSync(new URL("../src/server.ts", import.meta.url))) {
  run("tsc -p tsconfig.json");
} else {
  console.log("[postinstall] src/ not present — skipping tsc (Docker deps stage)");
}
