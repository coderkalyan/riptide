// Per-window runtime paths. The main process carries the INITIAL trace to open
// in the window URL (?vcd=<absolute path>); these are read once at module load
// to bootstrap the native db, hierarchy, and sidecar-derived view. Subsequent
// "Open VCD…" picks swap the trace IN PLACE (scene.ts `swapTrace`, no reload), so
// these reflect only the first trace — the live current path lives in scene.ts.
//
// The sidecar lives next to the trace (`<trace>.sidecar.json`): opening the
// bundled mock loads its curated view; opening a fresh trace finds no sidecar
// and starts empty.

// Tauri runtime detection. In the Tauri build, boot parameters come from
// bridge.bootInfo() (see index.tauri.tsx) rather than the window URL, the
// waveform canvas is a transparent hole Rust renders beneath (tauri/CanvasHost),
// and the value column / hover readout show Rust-pushed text (tauri/valuesStash).
export const IS_TAURI: boolean =
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

const params = new URLSearchParams(
  !IS_TAURI && typeof location !== "undefined" ? location.search : "",
);

export const VCD_PATH: string = params.get("vcd") ?? "";
export const SIDECAR_PATH: string = VCD_PATH ? `${VCD_PATH}.sidecar.json` : "";
// ?bench=1 → announce the window.__bench pack-cost harness in the console.
export const BENCH: boolean = params.get("bench") === "1";
