// The one build orchestrator. Builds the native Zig addon + the app (main
// process via tsc, renderer via esbuild) for any platform, cross-platform itself
// (pure Node fs/child_process — no cp/cd/mkdir -p/&& or env-prefix), so it runs
// the same on Linux, macOS and Windows and from CI.
//
//   node scripts/build.mjs [--target=<host|linux-x64|windows-x64|macos-arm64|macos-x64>]
//                          [--mode=<dev|release>]      (default: dev)
//                          [--steps=<all|native|app>]  (default: all)
//
// `host` compiles the addon natively for the current machine; the explicit
// triples cross-compile it (used by the release CI matrix). Importable too:
// `import { build } from "./build.mjs"` — scripts/dev.mjs reuses it.
import * as esbuild from "esbuild";
import { spawnSync } from "node:child_process";
import { mkdirSync, copyFileSync, existsSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const NATIVE_DIR = resolve(root, "native");
const DIST_NATIVE = resolve(root, "dist/native");
const DIST_RENDERER = resolve(root, "dist/renderer");
const TSC = resolve(root, "node_modules/typescript/bin/tsc");

// Each cross target → zig `-Dtarget` triple + where zig drops the shared lib.
// Windows lands in bin/ (a DLL), every other OS in lib/ (.so / .dylib). All of
// them are copied to the single canonical addon name `riptide.node` — an
// installer is one platform, so there's no reason to disambiguate by filename.
// linux-x64 pins a glibc version (2.31 = Ubuntu 20.04 baseline) rather than the
// bare "x86_64-linux" triple: with no version, zig 0.16's cross-linker emits a
// NEEDED entry of literal "libc.so" instead of the real soname "libc.so.6" (the
// former is only a linker script, not a loadable object) — the addon then fails
// to dlopen at runtime with "libc.so: invalid ELF header" (surfaced obscurely via
// Electron's console). Pinning any concrete glibc version fixes the soname; 2.31
// is chosen for broad distro compatibility, not because it's otherwise special.
const TARGETS = {
  "linux-x64": { zig: "x86_64-linux-gnu.2.31", out: "lib/libriptide.so" },
  "windows-x64": { zig: "x86_64-windows", out: "bin/riptide.dll" },
  "macos-arm64": { zig: "aarch64-macos", out: "lib/libriptide.dylib" },
  "macos-x64": { zig: "x86_64-macos", out: "lib/libriptide.dylib" },
};

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

// host → no -Dtarget (native build); figure out zig's output path from the OS.
function resolveTarget(name) {
  if (name === "host") {
    const out =
      process.platform === "win32" ? "bin/riptide.dll"
      : process.platform === "darwin" ? "lib/libriptide.dylib"
      : "lib/libriptide.so";
    return { zigTarget: null, out, isWin: process.platform === "win32" };
  }
  const t = TARGETS[name];
  if (!t) fail(`unknown --target=${name} (host | ${Object.keys(TARGETS).join(" | ")})`);
  return { zigTarget: t.zig, out: t.out, isWin: name === "windows-x64" };
}

function buildNative({ target, mode }) {
  // Preflight: zig + the two submodules the addon depends on. A clear message
  // here beats a cryptic zig "dependency not found" / "command not found".
  if (!hasCmd("zig", ["version"])) {
    fail("zig not found on PATH — install Zig 0.16.x (https://ziglang.org/download)");
  }
  for (const sub of ["tide", "tide-vcd"]) {
    if (!existsSync(resolve(root, sub, "build.zig"))) {
      fail(`submodule ${sub}/ not populated — run: git submodule update --init --recursive`);
    }
  }

  const { zigTarget, out, isWin } = resolveTarget(target);
  // Windows needs the generated napi trampoline shim compiled in (see the script).
  if (isWin) run("node", [resolve(root, "scripts/gen-win-napi-shim.mjs")]);

  const optimize = mode === "release" ? "ReleaseSafe" : "Debug";
  const args = ["build", `-Doptimize=${optimize}`];
  if (zigTarget) args.push(`-Dtarget=${zigTarget}`);
  run("zig", args, { cwd: NATIVE_DIR });

  mkdirSync(DIST_NATIVE, { recursive: true });
  copyFileSync(join(NATIVE_DIR, "zig-out", out), join(DIST_NATIVE, "riptide.node"));
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
