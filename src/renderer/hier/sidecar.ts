// Sidecar persistence — viewer state stored next to the trace, auto-loaded on
// start and auto-written on change. The hierarchy + waveform samples + enum
// tables are trace ("VCD") data (scene.ts / tide); the sidecar carries only
// the presentation overlay (which signals, in what order, how styled) plus the
// cursor/markers/time window and trivial UI chrome.
//
// Signals are keyed by hierarchical *path* (e.g. "top.keysched.waves.clk"), not
// by run-specific handles or row indices, so a sidecar from one simulation run
// opens a different run of the same design as long as the paths still resolve.
// The on-disk format and section semantics are documented in docs/sidecar.md
// and validated by docs/sidecar.schema.json.

import type { Hierarchy, NodeId } from "./types";
import { pathOf } from "./types";
import { getScope } from "./hierarchy";
import type { ActiveRole, ActiveSignalRef, Radix, VcdType } from "./scene";

// Renderer runs with nodeIntegration; mirror native.ts's runtime require so
// esbuild leaves the node builtins alone instead of trying to bundle them. The
// renderer tsconfig omits @types/node, so the surfaces we use are typed inline.
declare const require: (m: string) => unknown;
declare const process: { cwd(): string; env: Record<string, string | undefined> };
interface FsLike {
  readFileSync(p: string, enc: "utf8"): string;
  writeFileSync(p: string, data: string): void;
  renameSync(from: string, to: string): void;
}
interface PathLike {
  join(...parts: string[]): string;
}
const fs = require("fs") as FsLike;
const path = require("path") as PathLike;

export const SIDECAR_VERSION = 1;

// ---- on-disk shape ------------------------------------------------------

export interface SidecarSignal {
  path: string;
  radix: Radix;
  color: string;            // "#RRGGBB"
  hidden?: boolean;
  selected?: boolean;
  pinned?: boolean;
  role?: ActiveRole;
  derived?: { expr: string };
  // Reserved for forward-compat / scripting; not emitted by this build (enums
  // and muting are trace-side here). Documented in docs/sidecar.md.
  enumType?: string;
  gate?: string;
}

export interface SidecarMarker {
  name: string;
  tick: number;
  color: string;            // "#RRGGBB"
  selected?: boolean;
}

export interface ViewSection {
  time: { start: number; end: number; cursor: number };
  signals: SidecarSignal[];
  markers: SidecarMarker[];
}

export interface UiPanels {
  treeWidth: number;
  activeWidth: number;
  treeCollapsed: boolean;
  activeCollapsed: boolean;
  activeCompactWidth: number | null;
}

export interface UiSection {
  panels: UiPanels;
  tree: { expanded: string[] };
  toggles: { snapCursor: boolean; clockAnchor: boolean };
  tabs: { open: string[]; active: number };
}

export interface Sidecar {
  version: number;
  trace?: { id?: string; format?: string; timescale?: unknown };
  view: ViewSection;
  ui?: UiSection;
}

// ---- color helpers (packed u32 <-> "#RRGGBB") ---------------------------
// packRgba packs as 0xAABBGGRR (see gpu/text.ts), so the channels are LE.

export function packedToHex(rgba: number): string {
  const r = rgba & 0xff;
  const g = (rgba >>> 8) & 0xff;
  const b = (rgba >>> 16) & 0xff;
  const h = (n: number) => n.toString(16).padStart(2, "0");
  return `#${h(r)}${h(g)}${h(b)}`;
}

export function hexToPacked(hex: string): number {
  const m = /^#?([0-9a-fA-F]{6})$/.exec(hex.trim());
  if (!m) return 0xffffffff >>> 0; // opaque white fallback for malformed input
  const v = parseInt(m[1], 16);
  const r = (v >>> 16) & 0xff;
  const g = (v >>> 8) & 0xff;
  const b = v & 0xff;
  return (((0xff << 24) | (b << 16) | (g << 8) | r) >>> 0);
}

// ---- path index ---------------------------------------------------------
// path -> NodeId[] for every node (scope and signal). Array value so duplicate
// paths are detectable rather than silently shadowed.

export function buildPathIndex(h: Hierarchy): Map<string, NodeId[]> {
  const idx = new Map<string, NodeId[]>();
  for (const id of h.nodes.keys()) {
    const p = pathOf(h, id);
    const arr = idx.get(p);
    if (arr) arr.push(id);
    else idx.set(p, [id]);
  }
  return idx;
}

// ---- load / save --------------------------------------------------------

export function sidecarPath(): string {
  const override = (typeof process !== "undefined" && process.env && process.env.RIPTIDE_SIDECAR) || "";
  if (override) return override;
  return path.join(process.cwd(), "riptide.sidecar.json");
}

// Non-fatal: this runs at module load (buildMock). A parse error or missing
// file must fall back to the fresh view, never throw, or the app white-screens.
export function loadSidecar(p: string): Sidecar | null {
  let text: string;
  try {
    text = fs.readFileSync(p, "utf8");
  } catch {
    return null; // no sidecar -> fresh trace
  }
  try {
    const parsed = JSON.parse(text) as Sidecar;
    if (typeof parsed?.version !== "number" || Math.floor(parsed.version) !== SIDECAR_VERSION) {
      console.warn(`[sidecar] unsupported version ${parsed?.version} (expected ${SIDECAR_VERSION}); ignoring ${p}`);
      return null;
    }
    if (!parsed.view || !Array.isArray(parsed.view.signals)) {
      console.warn(`[sidecar] malformed (missing view.signals); ignoring ${p}`);
      return null;
    }
    return parsed;
  } catch (e) {
    console.warn(`[sidecar] parse error in ${p}; ignoring`, e);
    return null;
  }
}

// Atomic write: temp + rename so an external reader (CI) never sees a torn file.
export function writeSidecarFile(p: string, text: string): void {
  try {
    const tmp = `${p}.tmp`;
    fs.writeFileSync(tmp, text);
    fs.renameSync(tmp, p);
  } catch (e) {
    console.warn(`[sidecar] failed to write ${p}`, e);
  }
}

// ---- resolve (sidecar.view -> ActiveSignalRef[]) ------------------------

function vcdTypeOf(varType: string): VcdType {
  return varType === "vcd_reg" ? "reg" : "net";
}

export interface ResolveResult {
  activeSignals: ActiveSignalRef[];
  misses: string[];
}

export function resolveView(
  h: Hierarchy,
  idx: Map<string, NodeId[]>,
  view: ViewSection,
): ResolveResult {
  const activeSignals: ActiveSignalRef[] = [];
  const misses: string[] = [];
  let row = 0;
  for (const s of view.signals) {
    const ids = idx.get(s.path);
    if (!ids || ids.length === 0) {
      misses.push(s.path);
      continue;
    }
    if (ids.length > 1) {
      console.warn(`[sidecar] duplicate path "${s.path}"; using first match`);
    }
    const id = ids[0];
    const node = h.nodes.get(id);
    if (!node || node.kind !== "signal") {
      misses.push(s.path);
      continue;
    }
    activeSignals.push({
      signalId: id,
      row: row++,
      radix: s.radix,
      color: s.color,
      path: s.path,
      vcdType: s.derived ? "derived" : vcdTypeOf(node.varType),
      ...(s.pinned ? { pinned: true } : {}),
      ...(s.selected ? { selected: true } : {}),
      ...(s.hidden ? { hidden: true } : {}),
      ...(s.role ? { role: s.role } : {}),
      ...(s.derived ? { derivedExpr: s.derived.expr } : {}),
    });
  }
  return { activeSignals, misses };
}

export function resolveExpanded(idx: Map<string, NodeId[]>, paths: string[]): Set<NodeId> {
  const out = new Set<NodeId>();
  for (const p of paths) {
    const ids = idx.get(p);
    if (ids && ids.length) out.add(ids[0]);
  }
  return out;
}

// ---- serialize (current state -> on-disk Sidecar) -----------------------

export interface SidecarSnapshot {
  hierarchy: Hierarchy;
  trace?: { id?: string };
  activeSignals: ActiveSignalRef[];
  time: { start: number; end: number; cursor: number };
  markers: { name: string; tick: number; color: number; selected: boolean }[];
  panels: UiPanels;
  treeExpanded: Set<NodeId>;
  toggles: { snapCursor: boolean; clockAnchor: boolean };
  tabs: { open: string[]; active: number };
}

// Pure. Builds the object with a fixed key order (insertion order is preserved
// by JSON.stringify) so auto-write diffs stay minimal and git-friendly.
export function serializeSidecar(snap: SidecarSnapshot): Sidecar {
  const h = snap.hierarchy;
  const signals: SidecarSignal[] = snap.activeSignals.map((r) => ({
    path: r.path,
    radix: r.radix,
    color: r.color,
    ...(r.hidden ? { hidden: true } : {}),
    ...(r.selected ? { selected: true } : {}),
    ...(r.pinned ? { pinned: true } : {}),
    ...(r.role ? { role: r.role } : {}),
    ...(r.derivedExpr ? { derived: { expr: r.derivedExpr } } : {}),
  }));

  const markers: SidecarMarker[] = snap.markers.map((m) => ({
    name: m.name,
    tick: m.tick,
    color: packedToHex(m.color),
    ...(m.selected ? { selected: true } : {}),
  }));

  const expanded: string[] = [];
  for (const id of snap.treeExpanded) expanded.push(pathOf(h, id));
  expanded.sort();

  return {
    version: SIDECAR_VERSION,
    trace: {
      id: snap.trace?.id,
      timescale: h.timescale,
    },
    view: {
      time: { start: snap.time.start, end: snap.time.end, cursor: snap.time.cursor },
      signals,
      markers,
    },
    ui: {
      panels: snap.panels,
      tree: { expanded },
      toggles: { snapCursor: snap.toggles.snapCursor, clockAnchor: snap.toggles.clockAnchor },
      tabs: { open: snap.tabs.open, active: snap.tabs.active },
    },
  };
}

export function sidecarToString(s: Sidecar): string {
  return `${JSON.stringify(s, null, 2)}\n`;
}

// ---- INITIAL (view/markers/ui values for App.tsx) -----------------------
// Fresh defaults when no sidecar exists ("fresh VCD"); overridden by the
// sidecar's view/ui when one is loaded.

export interface InitialState {
  time: { start: number; end: number; cursor: number };
  markers: { name: string; tick: number; color: number; selected: boolean }[];
  panels: UiPanels;
  toggles: { snapCursor: boolean; clockAnchor: boolean };
  tabs: { open: string[]; active: number };
}

export function freshInitial(endTicks: number): InitialState {
  return {
    time: { start: 0, end: endTicks, cursor: 0 },
    markers: [],
    panels: {
      treeWidth: 236,
      activeWidth: 296,
      treeCollapsed: false,
      activeCollapsed: false,
      activeCompactWidth: null,
    },
    toggles: { snapCursor: false, clockAnchor: false },
    tabs: { open: ["keysched.vcd"], active: 0 },
  };
}

export function initialFromSidecar(sc: Sidecar, endTicks: number): InitialState {
  const fresh = freshInitial(endTicks);
  const ui = sc.ui;
  const markers = (sc.view.markers ?? []).map((m) => ({
    name: m.name,
    tick: m.tick,
    color: hexToPacked(m.color),
    selected: !!m.selected,
  }));
  return {
    time: {
      start: sc.view.time?.start ?? fresh.time.start,
      end: sc.view.time?.end ?? fresh.time.end,
      cursor: sc.view.time?.cursor ?? fresh.time.cursor,
    },
    markers,
    panels: ui?.panels ?? fresh.panels,
    toggles: ui?.toggles ?? fresh.toggles,
    tabs: ui?.tabs ?? fresh.tabs,
  };
}
