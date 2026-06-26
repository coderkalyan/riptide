// `pnpm dev` — build the host-native addon + app (debug), then launch Electron.
// `pnpm dev --blank` boots the idle/no-trace UI (RIPTIDE_NO_TRACE). Env is set on
// the spawned process (not a shell prefix) so it works on Windows too.
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "./build.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const blank = process.argv.includes("--blank");

await build({ target: "host", mode: "dev" });

// The `electron` package, required from Node, exports the path to its binary.
const require = createRequire(import.meta.url);
const electronBin = require("electron");

const env = { ...process.env };
if (blank) env.RIPTIDE_NO_TRACE = "1";

const r = spawnSync(electronBin, ["."], { stdio: "inherit", cwd: root, env });
process.exit(r.status ?? 0);
