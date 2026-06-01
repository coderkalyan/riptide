// Per-window runtime paths. The main process carries the trace to open in the
// window URL (?vcd=<absolute path>), so opening a different file is just a
// reload with a new query — every module-level constant (the native db, the
// hierarchy, the sidecar-derived view) recomputes from scratch on load.
//
// The sidecar lives next to the trace (`<trace>.sidecar.json`): opening the
// bundled mock loads its curated view; opening a fresh trace finds no sidecar
// and starts empty.

const params = new URLSearchParams(typeof location !== "undefined" ? location.search : "");

export const VCD_PATH: string = params.get("vcd") ?? "";
export const SIDECAR_PATH: string = VCD_PATH ? `${VCD_PATH}.sidecar.json` : "";
