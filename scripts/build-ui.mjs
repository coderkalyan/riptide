import * as esbuild from "esbuild";
import { copyFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { reactCompilerPlugin } from "./esbuild-react-compiler.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DST_DIR = resolve(root, "dist/renderer");

// Shared esbuild options for the renderer bundle — used by the one-shot prod
// build (below) and the dev:ui watch server (dev-ui.mjs). The react-compiler
// plugin runs Babel's auto-memoization over .tsx before esbuild bundles.
export const buildOptions = {
  entryPoints: [resolve(root, "src/renderer/index.tsx")],
  bundle: true,
  outfile: `${DST_DIR}/index.js`,
  format: "iife",
  target: "es2022",
  loader: { ".tsx": "tsx", ".wgsl": "text" },
  jsx: "automatic",
  external: ["../native/riptide.node", "fs", "path", "electron"],
  plugins: [reactCompilerPlugin()],
};

// Run directly (`node scripts/build-ui.mjs`) → one-shot build + copy index.html.
// Imported (dev-ui.mjs) → only export buildOptions, don't build.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  mkdirSync(DST_DIR, { recursive: true });
  await esbuild.build(buildOptions);
  copyFileSync(resolve(root, "src/renderer/index.html"), `${DST_DIR}/index.html`);
}
