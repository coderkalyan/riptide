import * as esbuild from "esbuild";
import { copyFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { solidPlugin } from "./esbuild-solid.mjs";
import { tailwindPlugin } from "./esbuild-tailwind.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DST_DIR = resolve(root, "dist/renderer");

// Production = minify + drop sourcemaps. Set by scripts/build.mjs via NODE_ENV
// before it imports this module; dev leaves it unset → readable bundle.
const PROD = process.env.NODE_ENV === "production";

// Shared esbuild options for the SolidJS renderer bundle. The solid plugin
// runs babel-preset-solid over .tsx (lowering JSX to template()/insert() calls)
// before esbuild bundles; plain .ts (gpu/, hier/, perf.ts) compile natively.
export const buildOptions = {
  entryPoints: [resolve(root, "src/renderer/index.tsx")],
  bundle: true,
  outfile: `${DST_DIR}/index.js`,
  format: "iife",
  target: "es2022",
  loader: { ".wgsl": "text", ".woff2": "file" },
  minify: PROD,
  sourcemap: PROD ? false : "linked",
  define: { "process.env.NODE_ENV": JSON.stringify(PROD ? "production" : "development") },
  external: ["../native/riptide.node", "fs", "path", "electron", "chokidar"],
  plugins: [solidPlugin(), tailwindPlugin()],
};

// Run directly (`node scripts/build-ui.mjs`) → one-shot build + copy index.html.
// Imported (dev-ui.mjs) → only export buildOptions, don't build.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  mkdirSync(DST_DIR, { recursive: true });
  await esbuild.build(buildOptions);
  copyFileSync(resolve(root, "src/renderer/index.html"), `${DST_DIR}/index.html`);
}
