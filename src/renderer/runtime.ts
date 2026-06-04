// Per-window runtime paths. The main process carries the INITIAL trace to open
// in the window URL (?vcd=<absolute path>); these are read once at module load
// to bootstrap the native db, hierarchy, and sidecar-derived view. Subsequent
// "Open VCD…" picks swap the trace IN PLACE (scene.ts `swapTrace`, no reload), so
// these reflect only the first trace — the live current path lives in scene.ts.
//
// The sidecar lives next to the trace (`<trace>.sidecar.json`): opening the
// bundled mock loads its curated view; opening a fresh trace finds no sidecar
// and starts empty.

const params = new URLSearchParams(typeof location !== "undefined" ? location.search : "");

export const VCD_PATH: string = params.get("vcd") ?? "";
export const SIDECAR_PATH: string = VCD_PATH ? `${VCD_PATH}.sidecar.json` : "";
// ?bench=1 → announce the window.__bench pack-cost harness in the console.
export const BENCH: boolean = params.get("bench") === "1";
