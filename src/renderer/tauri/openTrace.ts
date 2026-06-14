// In-app trace open for the Tauri build — the runtime counterpart to the
// boot-time load in index.tauri.tsx. App.tsx's Electron open flow
// (`ipcRenderer.invoke("riptide:open-vcd")` + `swapTrace`) is inert under
// Tauri (no electron ipc) and, worse, `swapTrace` would rebuild SCENE from the
// STALE installed hierarchy. Here we ask Rust to open (a native dialog when
// `path` is undefined, or a specific recent path), then refresh the scene
// stub's hierarchy from the bridge so the subsequent `swapTrace` rebuilds
// against the new trace.
//
// Imports are deliberately side-effect-free (no `webviewShims`) so App.tsx can
// import this in BOTH bundles; the Electron path never calls it. Sidecar
// restore on in-app open is a TODO (the boot path primes it; an in-app open
// starts from the trace's curated/empty view).

import { openVcd as bridgeOpenVcd, getHierarchy } from "../ipc/bridge";
import { marshalHierarchy } from "./hierarchy";
import { installHierarchy } from "./nativeStub";

/** True in the Tauri webview (the IPC bridge is present). */
export const IS_TAURI =
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

/**
 * Opens a trace through the Rust backend (native dialog when `path` is
 * omitted), installs its hierarchy into the scene stub, and returns the loaded
 * path — or `null` if the dialog was cancelled. Callers then run
 * `swapTrace(path)` + `resetForTrace()` exactly as the Electron path does.
 */
export async function openTraceTauri(path?: string): Promise<string | null> {
  const summary = await bridgeOpenVcd(path);
  if (!summary) return null;
  const dto = await getHierarchy();
  installHierarchy(marshalHierarchy(dto));
  return summary.path;
}
