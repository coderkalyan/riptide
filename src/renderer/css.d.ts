// Side-effect CSS imports (the Tailwind entry, bundled by esbuild) carry no JS
// shape — declare them so tsc accepts `import "./index.css"`.
declare module "*.css";
