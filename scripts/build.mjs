// The one build orchestrator. Builds the native Rust addon + the app (main
// process via tsc, renderer via esbuild) for any platform, cross-platform itself
// (pure Node fs/child_process — no cp/cd/mkdir -p/&& or env-prefix), so it runs
// the same on Linux, macOS and Windows and from CI.
//
//   node scripts/build.mjs [--target=<host|linux-x64|windows-x64|macos-arm64|macos-x64>]
//                          [--mode=<dev|release>]      (default: dev)
//                          [--steps=<all|native|app>]  (default: all)
//
// `host` compiles the addon for the current machine, which is what the release
// CI matrix does on each of its per-platform runners; the explicit triples ask
// cargo to cross-compile and need that target installed locally. Importable too:
// `import { build } from "./build.mjs"` — scripts/dev.mjs reuses it.
import * as esbuild from "esbuild";
import { spawnSync } from "node:child_process";
import { mkdirSync, copyFileSync, existsSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CARGO_TARGET = resolve(root, "target");
const DIST_NATIVE = resolve(root, "dist/native");
const DIST_RENDERER = resolve(root, "dist/renderer");
const TSC = resolve(root, "node_modules/typescript/bin/tsc");

// Each cross target → its Rust triple and the shared-library name cargo emits.
// Every one is copied to the single canonical addon name `riptide.node`: an
// installer is one platform, so there is no reason to disambiguate by filename,
// and `.node` is the only part Electron's loader cares about.
//
// Unlike the Zig toolchain this replaced, cargo does not cross-compile for free:
// an explicit triple needs its std (`rustup target add`) and a linker for that
// platform. CI never needs one — the release matrix runs a native build per
// runner — so these exist for local use only.
const TARGETS = {
  "linux-x64": { triple: "x86_64-unknown-linux-gnu", lib: "libriptide.so" },
  "windows-x64": { triple: "x86_64-pc-windows-msvc", lib: "riptide.dll" },
  "macos-arm64": { triple: "aarch64-apple-darwin", lib: "libriptide.dylib" },
  "macos-x64": { triple: "x86_64-apple-darwin", lib: "libriptide.dylib" },
};

// The differential suite runs this next to the addon; see tests/README.md.
const FIXTURE_EXE = "query-fixture";

function fail(msg) {
  console.error(`\n[build] ${msg}\n`);
  process.exit(1);
}

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { stdio: "inherit", cwd: root, ...opts });
  if (r.error) fail(`could not spawn '${cmd}': ${r.error.message}`);
  if (r.status !== 0) fail(`'${cmd} ${args.join(" ")}' exited with ${r.status}`);
}

function hasCmd(cmd, args = ["--version"]) {
  return !spawnSync(cmd, args, { stdio: "ignore" }).error;
}

// host → no --target, so cargo drops the artifact straight in target/<profile>;
// the library name still depends on the OS.
function resolveTarget(name) {
  if (name === "host") {
    const lib =
      process.platform === "win32" ? "riptide.dll"
      : process.platform === "darwin" ? "libriptide.dylib"
      : "libriptide.so";
    return { triple: null, lib, isWin: process.platform === "win32" };
  }
  const t = TARGETS[name];
  if (!t) fail(`unknown --target=${name} (host | ${Object.keys(TARGETS).join(" | ")})`);
  return { triple: t.triple, lib: t.lib, isWin: name === "windows-x64" };
}

function buildNative({ target, mode }) {
  // Preflight cargo and the tide crates the addon depends on. A clear message
  // here beats cargo's "failed to read .../Cargo.toml".
  if (!hasCmd("cargo")) {
    fail("cargo not found on PATH — install Rust (https://rustup.rs)");
  }
  if (!existsSync(resolve(root, "tide/crates/tide-core/Cargo.toml"))) {
    fail("submodule tide/ not populated — run: git submodule update --init");
  }

  const { triple, lib, isWin } = resolveTarget(target);
  const profile = mode === "release" ? "release" : "debug";

  const args = ["build", "--package", "riptide-native"];
  if (mode === "release") args.push("--release");
  if (triple) args.push("--target", triple);
  run("cargo", args);

  const out = triple ? join(CARGO_TARGET, triple, profile) : join(CARGO_TARGET, profile);
  mkdirSync(DIST_NATIVE, { recursive: true });
  copyFileSync(join(out, lib), join(DIST_NATIVE, "riptide.node"));

  // The seam-B differential runs this against the same crate the addon is built
  // from; without it beside the addon that suite has nothing to diff against.
  const fixture = isWin ? `${FIXTURE_EXE}.exe` : FIXTURE_EXE;
  copyFileSync(join(out, fixture), join(DIST_NATIVE, fixture));
}

async function buildApp({ mode }) {
  const prod = mode === "release";
  // Main process → CommonJS in dist/main.
  run("node", [TSC, "-p", "tsconfig.json"]);

  // Renderer → esbuild bundle. build-ui.mjs reads NODE_ENV at import to pick
  // minify/sourcemaps, so set it before importing (it only builds when run as a
  // script, otherwise just exports buildOptions).
  process.env.NODE_ENV = prod ? "production" : "development";
  const { buildOptions } = await import("./build-ui.mjs");
  mkdirSync(DIST_RENDERER, { recursive: true });
  await esbuild.build(buildOptions);
  copyFileSync(resolve(root, "src/renderer/index.html"), join(DIST_RENDERER, "index.html"));
  // Shipped alongside the renderer so the main process can hand it to
  // BrowserWindow — that is what gives Linux/Windows a real taskbar icon when
  // the app isn't desktop-integrated. Same file electron-builder packages from.
  copyFileSync(resolve(root, "build/icon.png"), join(DIST_RENDERER, "icon.png"));
}

export async function build({ target = "host", mode = "dev", steps = "all" } = {}) {
  if (steps === "all" || steps === "native") buildNative({ target, mode });
  if (steps === "all" || steps === "app") await buildApp({ mode });
}

function parseArgs(argv) {
  const opts = {};
  for (const a of argv) {
    const m = /^--(target|mode|steps)=(.+)$/.exec(a);
    if (m) opts[m[1]] = m[2];
    else fail(`unknown argument '${a}'`);
  }
  if (opts.mode && opts.mode !== "dev" && opts.mode !== "release") fail("--mode must be dev|release");
  if (opts.steps && !["all", "native", "app"].includes(opts.steps)) fail("--steps must be all|native|app");
  return opts;
}

// Run directly (vs. imported by dev.mjs).
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await build(parseArgs(process.argv.slice(2)));
}
