import babel from "@babel/core";
import { readFile } from "node:fs/promises";

// esbuild onLoad plugin: run babel-plugin-react-compiler over renderer .tsx
// files (where every React component/hook lives). Babel parses + strips TS types
// (@babel/preset-typescript) and applies the compiler, leaving JSX for esbuild
// to transform downstream. The compiler auto-memoizes components/hooks against
// the React 19 runtime (react/compiler-runtime), so render-skipping no longer
// needs hand-written memo()/useCallback/useMemo.
//
// Only .tsx is processed — plain .ts modules (gpu/, hier/, perf.ts) hold no
// components, so esbuild compiles them natively and they skip this Babel pass.
export function reactCompilerPlugin() {
  return {
    name: "react-compiler",
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
          // isTSX so generics like useState<T>() parse as types, not JSX.
          presets: [["@babel/preset-typescript", { isTSX: true, allExtensions: true }]],
          plugins: [["babel-plugin-react-compiler", { target: "19" }]],
        });
        // Types stripped, JSX intact → hand to esbuild's jsx loader.
        return { contents: result?.code ?? source, loader: "jsx" };
      });
    },
  };
}
