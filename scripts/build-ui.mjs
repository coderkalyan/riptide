import * as esbuild from "esbuild";
import { copyFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { solidPlugin } from "./esbuild-solid.mjs";
import { tailwindPlugin } from "./esbuild-tailwind.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DST_DIR = resolve(root, "dist/renderer");

// Production = minify + drop sourcemaps. Set via NODE_ENV=production (electron-
// builder / `build:prod`). Dev + dev:ui leave it unset → readable bundle.
const PROD = process.env.NODE_ENV === "production";

// RIPTIDE_TAURI=1 → bundle the Tauri entry (src/renderer/index.tauri.tsx)
// instead of the Electron one. The webview can't dlopen the napi addon, so the
// native externals are dropped and two module aliases swap the Electron-only
// seams for their Tauri counterparts (default behavior is unchanged):
//   - "./native" / "../native"  → tauri/nativeStub.ts (no addon; hierarchy is
//     installed from bridge.getHierarchy, queries are inert)
//   - "./wave/WaveCanvas"       → tauri/CanvasHost.tsx (transparent hole the
//     Rust/wgpu renderer draws beneath; exports the WaveCanvas name)
const TAURI = process.env.RIPTIDE_TAURI === "1";

function tauriAliasPlugin() {
  const rendererDir = resolve(root, "src/renderer");
  return {
    name: "tauri-alias",
    setup(build) {
      build.onResolve({ filter: /^\.\.?\/native$/ }, () => ({
        path: resolve(rendererDir, "tauri/nativeStub.ts"),
      }));
      build.onResolve({ filter: /^\.\.?\/wave\/WaveCanvas$/ }, () => ({
        path: resolve(rendererDir, "tauri/CanvasHost.tsx"),
      }));
    },
  };
}

// Shared esbuild options for the SolidJS renderer bundle — used by the one-shot
// prod build (below) and the dev:ui watch server (dev-ui.mjs). The solid plugin
// runs babel-preset-solid over .tsx (lowering JSX to template()/insert() calls)
// before esbuild bundles; plain .ts (gpu/, hier/, perf.ts) compile natively.
export const buildOptions = {
  entryPoints: [resolve(root, TAURI ? "src/renderer/index.tauri.tsx" : "src/renderer/index.tsx")],
  bundle: true,
  outfile: `${DST_DIR}/index.js`,
  format: "iife",
  target: "es2022",
  loader: { ".wgsl": "text" },
  minify: PROD,
  sourcemap: PROD ? false : "linked",
  define: { "process.env.NODE_ENV": JSON.stringify(PROD ? "production" : "development") },
  external: TAURI
    ? ["fs", "path", "electron"]
    : ["../native/riptide.node", "../native/riptide-win.node", "fs", "path", "electron"],
  plugins: [...(TAURI ? [tauriAliasPlugin()] : []), solidPlugin(), tailwindPlugin()],
};

// Run directly (`node scripts/build-ui.mjs`) → one-shot build + copy index.html.
// Imported (dev-ui.mjs) → only export buildOptions, don't build.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  mkdirSync(DST_DIR, { recursive: true });
  await esbuild.build(buildOptions);
  copyFileSync(resolve(root, "src/renderer/index.html"), `${DST_DIR}/index.html`);
}
