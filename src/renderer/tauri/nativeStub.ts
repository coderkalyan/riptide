// Bundle-time replacement for src/renderer/native.ts in the Tauri build: the
// webview can't dlopen the napi addon, and all render-rate work (pack, value
// lookup, edge scan) lives in Rust there. scripts/build-ui.mjs (RIPTIDE_TAURI=1)
// aliases every `import ... from "../native"` to this module, so the shared
// data layers (hier/scene.ts, wave/value.ts, wave/clock.ts) keep compiling
// unchanged while their native queries become inert:
//
//   - getHierarchy() returns the hierarchy installed from bridge.getHierarchy()
//     (the DTO is marshalled by tauri/hierarchy.ts in index.tauri.tsx).
//   - getMockSegments() returns an empty pack — nothing draws GPU buffers in the
//     webview (Rust renders beneath the transparent CanvasHost).
//   - getValueAt()/getEdges() return null — the value column / hover readout use
//     Rust-pushed text (tauri/valuesStash.ts) and clock-grid detection comes in
//     over the UiEvent channel (clockGridChanged).
//
// NOTE: typecheck always resolves "../native" to the real native.ts (tsc knows
// nothing of the esbuild alias); only the bundle swaps in this file. Keep the
// exported runtime surface a subset-compatible mirror of native.ts.

import type { Hierarchy } from "../hier/types";
import type { NativeEdges, NativeMockSegments, NativePackSpec } from "../native";

let hierarchy: Hierarchy | null = null;
let traceLoaded = false;

/** Install the hierarchy marshalled from the bridge's HierarchyDto (boot/swap). */
export function installHierarchy(h: Hierarchy): void {
  hierarchy = h;
  traceLoaded = true;
}

export function hasTrace(): boolean {
  return traceLoaded;
}

// Rust owns the trace db (it loaded the VCD before the webview booted); the
// scene-layer swapTrace call is a no-op here beyond flipping the flag.
export function loadVcd(_path: string): void {
  traceLoaded = true;
}

export function getHierarchy(): Hierarchy {
  if (!hierarchy) {
    throw new Error("tauri nativeStub: no hierarchy installed (installHierarchy first)");
  }
  return hierarchy;
}

export function getMockSegments(
  _specs: NativePackSpec[],
  _qStart: number,
  _qEnd: number,
): NativeMockSegments {
  return {
    multi: new Uint32Array(0),
    multiCount: 0,
    single: new Uint32Array(0),
    singleCount: 0,
    rowInfo: new ArrayBuffer(0),
    rowCount: 0,
    x0Pool: new ArrayBuffer(0),
    x1Pool: new ArrayBuffer(0),
    labelBytes: new Uint8Array(0),
    labelOffsets: new Uint32Array(1),
    singleLabelBytes: new Uint8Array(0),
    singleLabelOffsets: new Uint32Array(1),
    endTicks: 0,
  };
}

export function getValueAt(
  _handle: string,
  _tick: number,
): { lsb: number[]; msb: number[] } | null {
  return null;
}

export function getEdges(
  _handle: string,
  _startTick: number,
  _count: number,
): NativeEdges | null {
  return null;
}
