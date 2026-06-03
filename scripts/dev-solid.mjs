import * as esbuild from "esbuild";
import { watch, copyFileSync, mkdirSync, utimesSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { solidPlugin } from "./esbuild-solid.mjs";

// Solid renderer dev server — mirrors dev-ui.mjs but bundles src/renderer-solid
// with babel-preset-solid into its own dist dir. Serves on :5173, the same port
// the main process loads under RIPTIDE_DEV=1, so `RIPTIDE_DEV=1 electron .`
// launches the Solid app with NO main-process change. Run only one of dev-ui /
// dev-solid at a time (they share the port).
//
// The HTML (with its inline CSS + #root + <script src="index.js">) is reused
// VERBATIM from the React renderer — index.js resolves to the Solid bundle in
// this output dir, so the CSS is shared without being touched or duplicated.

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SRC_HTML = resolve(root, "src/renderer/index.html");
const ENTRY = resolve(root, "src/renderer-solid/index.tsx");
const DST_DIR = resolve(root, "dist/renderer-solid");
const PROD = process.env.NODE_ENV === "production";

mkdirSync(DST_DIR, { recursive: true });
copyFileSync(SRC_HTML, `${DST_DIR}/index.html`);

// On HTML change: copy to dist, then touch the TS entry so esbuild rebuilds and
// its live-reload EventSource fires in the browser.
watch(SRC_HTML, () => {
  copyFileSync(SRC_HTML, `${DST_DIR}/index.html`);
  const t = new Date();
  utimesSync(ENTRY, t, t);
});

const ctx = await esbuild.context({
  entryPoints: [ENTRY],
  bundle: true,
  outfile: `${DST_DIR}/index.js`,
  format: "iife",
  target: "es2022",
  loader: { ".wgsl": "text" },
  minify: PROD,
  sourcemap: PROD ? false : "linked",
  define: { "process.env.NODE_ENV": JSON.stringify(PROD ? "production" : "development") },
  external: ["../native/riptide.node", "fs", "path", "electron"],
  plugins: [solidPlugin()],
});
await ctx.watch();
await ctx.serve({ host: "localhost", port: 5173, servedir: DST_DIR });

console.log("Solid UI dev server → http://localhost:5173");
