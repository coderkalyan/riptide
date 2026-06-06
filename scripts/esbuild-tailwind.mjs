// esbuild plugin: run the renderer's CSS entry (src/renderer/index.css) through
// Tailwind v4's PostCSS plugin so `@import "tailwindcss"`, `@theme`, and `@apply`
// are compiled before esbuild bundles the result into dist/renderer/index.css.
//
// Hybrid styling (see plan): the file is mostly semantic component classes built
// with @apply over @theme tokens, so the utilities we need are referenced inside
// the CSS itself (always emitted) plus a few raw utilities in .tsx (Tailwind v4
// auto-scans the project for those). `from` is set so Tailwind resolves content
// + relative paths against the CSS file's location.
import { readFile } from "node:fs/promises";
import postcss from "postcss";
import tailwind from "@tailwindcss/postcss";

export function tailwindPlugin() {
  return {
    name: "tailwind",
    setup(build) {
      build.onLoad({ filter: /src[\\/]renderer[\\/]index\.css$/ }, async (args) => {
        const raw = await readFile(args.path, "utf8");
        const result = await postcss([tailwind()]).process(raw, { from: args.path });
        return { contents: result.css, loader: "css" };
      });
    },
  };
}
