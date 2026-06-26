// `pnpm check` — all static checks in one place: WGSL validation + both TS
// projects (main + renderer) type-checked. naga (the WGSL validator) is treated
// as optional: a fresh contributor without the Rust tool can still `pnpm dev`,
// but CI and release builds have it and enforce it.
import { spawnSync } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const TSC = resolve(root, "node_modules/typescript/bin/tsc");

function run(cmd, args) {
  const r = spawnSync(cmd, args, { stdio: "inherit", cwd: root });
  return r.error ? 1 : (r.status ?? 1);
}

let rc = 0;

if (spawnSync("naga", ["--version"], { stdio: "ignore" }).error) {
  console.warn("[check] naga not found — skipping WGSL validation (install naga-cli to enable)");
} else {
  rc |= run("node", [resolve(root, "scripts/wgsl-check.mjs")]);
}

rc |= run("node", [TSC, "-p", "tsconfig.json", "--noEmit"]);
rc |= run("node", [TSC, "-p", "tsconfig.renderer.json", "--noEmit"]);

process.exit(rc ? 1 : 0);
