// Webview-survival shims for the Tauri entry. MUST be the FIRST import of
// index.tauri.tsx (side-effect module): some shared renderer modules were
// written for Electron's node-integrated renderer and call a free `require()`
// at module-init time (hier/sidecar.ts: `const fs = require("fs")`). The Tauri
// webview has no `require`, so without this shim the bundle throws before the
// app boots. The shim provides just enough of `fs`/`path`/`process` for those
// modules to load and degrade gracefully.
//
// Sidecar reads are served from an in-memory prime table: index.tauri.tsx
// prefetches the sidecar text through bridge.readSidecar and `primeFile()`s it
// here, so the existing synchronous loadSidecar path (hier/sidecar.ts) finds
// it. Writes throw — writeSidecarFile catches and warns.
// TODO(U11/U15 integration): delete this once hier/sidecar.ts goes through the
// Tauri bridge natively (async read/write commands).

const files = new Map<string, string>();

/** Pre-seed a file's content so the fs shim's readFileSync can return it. */
export function primeFile(path: string, text: string): void {
  files.set(path, text);
}

const fsShim = {
  readFileSync(p: string, _enc: "utf8"): string {
    const t = files.get(p);
    if (t == null) throw new Error(`ENOENT (tauri webview fs shim): ${p}`);
    return t;
  },
  writeFileSync(_p: string, _data: string): void {
    throw new Error(
      "fs.writeFileSync unavailable in the Tauri webview (sidecar writes go through the bridge at integration)",
    );
  },
  renameSync(_from: string, _to: string): void {
    throw new Error("fs.renameSync unavailable in the Tauri webview");
  },
};

const pathShim = {
  join(...parts: string[]): string {
    return parts.filter(Boolean).join("/");
  },
};

const g = globalThis as Record<string, unknown>;
if (typeof g.require === "undefined") {
  g.require = (m: string) => {
    if (m === "fs") return fsShim;
    if (m === "path") return pathShim;
    throw new Error(`module "${m}" unavailable in the Tauri webview`);
  };
}
if (typeof g.process === "undefined") {
  // Minimal process for `typeof process !== "undefined"` guards + sidecarPath().
  g.process = { cwd: () => "/", env: {}, platform: "linux" };
}
