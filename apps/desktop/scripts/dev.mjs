#!/usr/bin/env node
// Dev server: compiles main process, starts esbuild serve+watch for renderer,
// watches index.html for changes, then launches Electron.
import { spawn } from "child_process";
import { watch, copyFileSync, mkdirSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SRC_HTML = resolve(root, "src/renderer/index.html");
const DST_DIR  = resolve(root, "dist/renderer");
const DST_HTML = resolve(DST_DIR, "index.html");
const DEV_PORT = 5173;

function run(cmd, args, opts = {}) {
  return spawn(cmd, args, { cwd: root, stdio: "inherit", ...opts });
}

// 1. Prep dist dir + copy HTML
mkdirSync(DST_DIR, { recursive: true });
copyFileSync(SRC_HTML, DST_HTML);

// Watch index.html — copy on change (esbuild live-reload picks it up)
watch(SRC_HTML, () => {
  copyFileSync(SRC_HTML, DST_HTML);
  process.stdout.write("index.html updated\n");
});

// 2. Compile main process (one-shot tsc)
console.log("Building main process...");
const tsc = run("node_modules/.bin/tsc", ["-p", "tsconfig.json"]);
tsc.on("exit", (code) => {
  if (code !== 0) { process.exit(code); }

  // 3. Start esbuild serve + watch for renderer
  //    --watch rebuilds proactively and injects live-reload EventSource
  const esbuild = run("node_modules/.bin/esbuild", [
    "src/renderer/index.tsx",
    "--bundle",
    `--outfile=${DST_DIR}/index.js`,
    "--format=iife",
    "--target=es2022",
    "--loader:.tsx=tsx",
    "--jsx=automatic",
    "--watch",
    `--serve=localhost:${DEV_PORT}`,
    `--servedir=${DST_DIR}`,
  ]);

  // 4. Launch Electron after a short pause (let esbuild bind its port)
  setTimeout(() => {
    console.log(`Opening http://localhost:${DEV_PORT} in Electron...`);
    const electron = run(
      "node_modules/.bin/electron",
      ["."],
      { env: { ...process.env, RIPTIDE_DEV: "1" } }
    );
    electron.on("exit", () => { esbuild.kill(); process.exit(); });
  }, 600);
});
