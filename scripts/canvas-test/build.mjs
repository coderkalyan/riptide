// Bundle the canvas-test harness (+ the real gpu/ modules it imports, resolving
// .wgsl text imports) into a single ESM that Deno's native WebGPU can run.
// Node has no built-in WebGPU; Deno does — so we build here, run under Deno.
import * as esbuild from "esbuild";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));

await esbuild.build({
  entryPoints: [here + "harness.ts"],
  outfile: here + "harness.bundle.mjs",
  bundle: true,
  format: "esm",
  platform: "neutral",
  target: "es2022",
  loader: { ".wgsl": "text" },
  logLevel: "info",
});

await esbuild.stop();
