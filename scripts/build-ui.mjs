import * as esbuild from "esbuild";
import { copyFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { solidPlugin } from "./esbuild-solid.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DST_DIR = resolve(root, "dist/renderer");

// Production = minify + drop sourcemaps. Set via NODE_ENV=production (electron-
// builder / `build:prod`). Dev + dev:ui leave it unset → readable bundle.
const PROD = process.env.NODE_ENV === "production";

// Shared esbuild options for the SolidJS renderer bundle — used by the one-shot
// prod build (below) and the dev:ui watch server (dev-ui.mjs). The solid plugin
// runs babel-preset-solid over .tsx (lowering JSX to template()/insert() calls)
// before esbuild bundles; plain .ts (gpu/, hier/, perf.ts) compile natively.
export const buildOptions = {
  entryPoints: [resolve(root, "src/renderer/index.tsx")],
  bundle: true,
  outfile: `${DST_DIR}/index.js`,
  format: "iife",
  target: "es2022",
  loader: { ".wgsl": "text" },
  minify: PROD,
  sourcemap: PROD ? false : "linked",
  define: { "process.env.NODE_ENV": JSON.stringify(PROD ? "production" : "development") },
  external: ["../native/riptide.node", "../native/riptide-win.node", "fs", "path", "electron"],
  plugins: [solidPlugin()],
};

// Run directly (`node scripts/build-ui.mjs`) → one-shot build + copy index.html.
// Imported (dev-ui.mjs) → only export buildOptions, don't build.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  mkdirSync(DST_DIR, { recursive: true });
  await esbuild.build(buildOptions);
  copyFileSync(resolve(root, "src/renderer/index.html"), `${DST_DIR}/index.html`);
}
