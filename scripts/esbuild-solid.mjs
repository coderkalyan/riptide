import babel from "@babel/core";
import { readFile } from "node:fs/promises";

// esbuild onLoad plugin: compile the Solid renderer's .tsx via babel-preset-solid.
// @babel/preset-typescript strips TS types first (isTSX so generics parse, not
// JSX), then babel-preset-solid lowers JSX *entirely* into Solid's
// template()/insert()/createComponent runtime calls — the output has NO JSX, so
// we return loader:"js" (returning "jsx" would make esbuild run a second,
// React-flavoured JSX transform over the already-lowered code).
//
// Only the renderer's .tsx (the Solid components) are matched; the shared plain
// .ts modules (gpu/, hier/, native.ts, perf.ts, runtime.ts) skip Babel so
// esbuild compiles them natively.
export function solidPlugin() {
  const PROD = process.env.NODE_ENV === "production";
  return {
    name: "solid",
    setup(build) {
      build.onLoad({ filter: /[\\/]renderer[\\/].*\.tsx$/ }, async (args) => {
        const source = await readFile(args.path, "utf8");
        const result = await babel.transformAsync(source, {
          filename: args.path,
          babelrc: false,
          configFile: false,
          highlightCode: false,
          sourceType: "module",
          sourceMaps: "inline",
          presets: [
            ["@babel/preset-typescript", { isTSX: true, allExtensions: true }],
            ["babel-preset-solid", { dev: !PROD }],
          ],
        });
        return { contents: result?.code ?? source, loader: "js" };
      });
    },
  };
}
