// `pnpm test` — build the host addon, then run every suite: static checks, the
// Zig oracle + headless node suites (tests/run.sh), the Electron visual
// regression (run-headless.sh), and the GPU canvas golden (deno). Suites whose
// external tool is missing (bash / sway / deno / a display) self-skip rather than
// fail, so the single command stays honest about what actually ran.
//
// `pnpm test --update` regenerates the visual + canvas goldens instead of
// comparing against them.
import { spawnSync } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "./build.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const update = process.argv.includes("--update");

const have = (cmd, args = ["--version"]) => !spawnSync(cmd, args, { stdio: "ignore" }).error;

let rc = 0;
function step(name, fn) {
  console.log(`\n=== ${name} ===`);
  rc |= fn() ?? 0;
}
function sh(cmd, args, env) {
  const r = spawnSync(cmd, args, { stdio: "inherit", cwd: root, env: { ...process.env, ...env } });
  return r.error ? 1 : (r.status ?? 1);
}

// Everything below needs the addon (+ query-fixture) and the renderer bundle.
await build({ target: "host", mode: "dev" });

if (update) {
  if (have("sway", ["--version"]) && have("bash"))
    step("visual goldens", () => sh("bash", ["tests/e2e/run-headless.sh"], { UPDATE_GOLDENS: "1" }));
  else console.log("\n=== visual goldens === skipped (needs bash + sway)");

  if (have("deno"))
    step("canvas goldens", () => {
      const b = sh("node", ["scripts/canvas-test/build.mjs"]);
      return b || sh("deno", ["run", "--allow-all", "scripts/canvas-test/harness.bundle.mjs", "--update"]);
    });
  else console.log("\n=== canvas goldens === skipped (needs deno)");
  process.exit(rc ? 1 : 0);
}

step("check", () => sh("node", ["scripts/check.mjs"]));

if (have("bash")) step("oracle + node suites", () => sh("bash", ["tests/run.sh"]));
else console.log("\n=== oracle + node suites === skipped (needs bash)");

if (have("sway", ["--version"]) && have("bash"))
  step("visual regression", () => sh("bash", ["tests/e2e/run-headless.sh"]));
else console.log("\n=== visual regression === skipped (needs bash + sway)");

if (have("deno"))
  step("canvas golden", () => {
    const b = sh("node", ["scripts/canvas-test/build.mjs"]);
    return b || sh("deno", ["run", "--allow-all", "scripts/canvas-test/harness.bundle.mjs"]);
  });
else console.log("\n=== canvas golden === skipped (needs deno)");

process.exit(rc ? 1 : 0);
