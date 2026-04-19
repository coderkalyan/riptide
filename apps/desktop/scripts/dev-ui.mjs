import { spawn } from "child_process";
import { watch, copyFileSync, mkdirSync, utimesSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const root    = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SRC_HTML = resolve(root, "src/renderer/index.html");
const ENTRY   = resolve(root, "src/renderer/index.tsx");
const DST_DIR = resolve(root, "dist/renderer");

mkdirSync(DST_DIR, { recursive: true });
copyFileSync(SRC_HTML, `${DST_DIR}/index.html`);

// On HTML change: copy to dist, then touch the TS entry so esbuild
// rebuilds and its live-reload EventSource fires in the browser.
watch(SRC_HTML, () => {
  copyFileSync(SRC_HTML, `${DST_DIR}/index.html`);
  const t = new Date();
  utimesSync(ENTRY, t, t);
});

spawn("node_modules/.bin/esbuild", [
  "src/renderer/index.tsx",
  "--bundle",
  `--outfile=${DST_DIR}/index.js`,
  "--format=iife", "--target=es2022",
  "--loader:.tsx=tsx", "--jsx=automatic",
  "--watch",
  "--serve=localhost:5173",
  `--servedir=${DST_DIR}`,
], { cwd: root, stdio: "inherit" });

console.log("UI dev server → http://localhost:5173");
