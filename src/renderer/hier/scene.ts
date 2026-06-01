import type { EnumType, Hierarchy, NodeId, Scope, Signal } from "./types";
import { getHierarchy, type NativePackSpec } from "../native";
import { MOCK_END_TICKS } from "../gpu/data";
import {
  buildPathIndex,
  freshInitial,
  initialFromSidecar,
  loadSidecar,
  resolveExpanded,
  resolveView,
  sidecarPath,
  type InitialState,
  type Sidecar,
} from "./sidecar";

export type Radix = "bin" | "hex" | "dec";
export type ActiveRole = "clock" | "reset" | "valid";

// VCD variable kind shown in the row tooltip. Mock for now; "derived" covers
// user expressions stored as precomputed waveforms in tide.
export type VcdType = "net" | "reg" | "derived";

export interface ActiveSignalRef {
  signalId: NodeId;
  row: number;
  radix: Radix;
  color: string;
  path: string;
  vcdType: VcdType;
  pinned?: boolean;
  selected?: boolean;
  hidden?: boolean;
  role?: ActiveRole;
  derivedExpr?: string;
}

export interface Scene {
  hierarchy: Hierarchy;
  activeSignals: ActiveSignalRef[];
  initialExpanded: Set<NodeId>;
}

// ---- per-row display config --------------------------------------------
// `handle` strings match tide.Signal.Id values assigned in mock_db.zig (Row
// enum 0..13). Everything here is presentation metadata that tide's mock
// hierarchy does not carry; it is overlaid on top of the native hierarchy.

interface RowConfig {
  handle: string;
  row: number;
  radix: Radix;
  color: string;
  vcdType: VcdType;
  pinned?: boolean;
  selected?: boolean;
  role?: ActiveRole;
  derivedExpr?: string;
  gateHandle?: string;       // mute this row when the gate signal isn't logic-1
  enumTypeId?: number;       // overlay onto the signal node (tide lacks enums)
}

const W = "top.keysched.waves";
const ROWS: (RowConfig & { path: string })[] = [
  { handle: "0",  row: 0,  radix: "bin", role: "clock", pinned: true,                 color: "#72F5DF", path: `${W}.clk`,              vcdType: "net" },
  { handle: "1",  row: 1,  radix: "bin", role: "reset",                               color: "#F06B5B", path: `${W}.rst`,              vcdType: "reg" },
  { handle: "2",  row: 2,  radix: "dec", selected: true, enumTypeId: 1,               color: "#B48CFF", path: `${W}.state[1:0]`,       vcdType: "reg" },
  { handle: "3",  row: 3,  radix: "dec",                                              color: "#B48CFF", path: `${W}.cycle_count[7:0]`, vcdType: "reg" },
  { handle: "4",  row: 4,  radix: "bin", role: "valid",                               color: "#F4A698", path: `${W}.in_valid`,         vcdType: "reg" },
  { handle: "5",  row: 5,  radix: "hex", gateHandle: "4",                             color: "#F4A698", path: `${W}.in_data[7:0]`,     vcdType: "reg" },
  { handle: "6",  row: 6,  radix: "hex", gateHandle: "4",                             color: "#F4A698", path: `${W}.in_addr[15:0]`,    vcdType: "reg" },
  { handle: "7",  row: 7,  radix: "bin", role: "valid",                               color: "#57C88A", path: `${W}.out_valid`,        vcdType: "reg" },
  { handle: "8",  row: 8,  radix: "hex", gateHandle: "7",                             color: "#57C88A", path: `${W}.out_data[31:0]`,   vcdType: "reg" },
  { handle: "9",  row: 9,  radix: "dec",                                              color: "#E6B14E", path: `${W}.fifo_level[3:0]`,  vcdType: "reg" },
  { handle: "10", row: 10, radix: "bin",                                              color: "#E6B14E", path: `${W}.fifo_empty`,       vcdType: "net" },
  { handle: "11", row: 11, radix: "hex",                                              color: "#4FD2BD", path: `${W}.dbus[7:0]`,        vcdType: "net" },
  { handle: "12", row: 12, radix: "bin", derivedExpr: "in_valid | out_valid",         color: "#4FD2BD", path: "derived.busy",         vcdType: "derived" },
  { handle: "13", row: 13, radix: "bin", derivedExpr: "state == DONE",                color: "#4FD2BD", path: "derived.done",         vcdType: "derived" },
];

// Enum types live TS-side (tide's mock hierarchy carries the integer value but
// no int→label table, per the integration decision).
const ENUM_TYPES: EnumType[] = [
  {
    id: 1,
    name: "state_t",
    members: [
      { raw: "00", label: "IDLE" },
      { raw: "01", label: "BUSY" },
      { raw: "10", label: "WAIT" },
    ],
  },
];

const INITIAL_EXPANDED_PATHS = ["top", "top.keysched", "top.keysched.waves", "derived"];

function lookupByHandle(h: Hierarchy, handle: string): NodeId {
  const ids = h.byHandle.get(handle);
  if (!ids || ids.length === 0) throw new Error(`Unknown signal handle: ${handle}`);
  return ids[0];
}

function lookupByPath(h: Hierarchy, path: string): NodeId {
  const parts = path.split(".");
  let candidates = h.rootIds;
  let found: NodeId | null = null;
  for (let i = 0; i < parts.length; i++) {
    found = null;
    for (const id of candidates) {
      const node = h.nodes.get(id);
      if (node && node.name === parts[i]) { found = id; break; }
    }
    if (found == null) throw new Error(`Path not found: ${path} (at "${parts[i]}")`);
    if (i + 1 < parts.length) {
      const node = h.nodes.get(found)!;
      if (node.kind !== "scope") throw new Error(`Path crosses non-scope: ${path}`);
      candidates = (node as Scope).children;
    }
  }
  return found!;
}

// Gate handles keyed by signal path. Trace semantics (mute a row while its gate
// signal isn't logic-1), applied whether the active signals come from a sidecar
// or the curated default — so the sidecar never has to carry gate info.
const GATE_BY_PATH = new Map<string, string>();
for (const r of ROWS) if (r.gateHandle) GATE_BY_PATH.set(r.path, r.gateHandle);

function handleOf(h: Hierarchy, id: NodeId): string {
  const node = h.nodes.get(id);
  return node && node.kind === "signal" ? (node as Signal).handle : "";
}

// Native pack specs from the active signal list — what tide should query + how
// to pack each row. kind/shade come from the role; gate is path-keyed.
function specsFromActive(h: Hierarchy, active: ActiveSignalRef[]): NativePackSpec[] {
  return active.map((s) => ({
    row: s.row,
    handle: handleOf(h, s.signalId),
    kind: s.role === "clock" ? "clk" : "data",
    shaded: s.role !== "clock",
    gateHandle: GATE_BY_PATH.get(s.path) ?? null,
  }));
}

// Curated default active signals (used when no sidecar is present).
function defaultActiveSignals(hierarchy: Hierarchy): ActiveSignalRef[] {
  return ROWS.map((r) => ({
    signalId: lookupByHandle(hierarchy, r.handle),
    row: r.row,
    radix: r.radix,
    color: r.color,
    path: r.path,
    vcdType: r.vcdType,
    pinned: r.pinned,
    selected: r.selected,
    role: r.role,
    derivedExpr: r.derivedExpr,
  }));
}

// Computed in buildScene from the active signal list; returned to App.tsx, which
// feeds it to getMockSegments.
let SCENE_PACK_SPECS: NativePackSpec[] = [];
export function buildPackSpecs(): NativePackSpec[] {
  return SCENE_PACK_SPECS;
}

function buildScene(sc: Sidecar | null): Scene {
  const hierarchy = getHierarchy();

  // Overlay TS-only metadata that tide's mock hierarchy doesn't carry. Enum
  // association is keyed by handle here, independent of the sidecar.
  hierarchy.format = "fst";
  hierarchy.timescale = { value: 1, unit: "ns", precision: { value: 10, unit: "ps" } };
  for (const t of ENUM_TYPES) hierarchy.enumTypes.set(t.id, t);
  for (const r of ROWS) {
    if (r.enumTypeId == null) continue;
    const node = hierarchy.nodes.get(lookupByHandle(hierarchy, r.handle));
    if (node && node.kind === "signal") (node as Signal).enumTypeId = r.enumTypeId;
  }

  // Active signals + tree expansion come from the sidecar when one exists; else
  // the curated default. Unresolved sidecar paths are skipped (non-fatal).
  let activeSignals: ActiveSignalRef[];
  let initialExpanded: Set<NodeId>;
  if (sc) {
    const idx = buildPathIndex(hierarchy);
    const r = resolveView(hierarchy, idx, sc.view);
    if (r.misses.length) console.warn("[sidecar] unresolved signal paths (skipped):", r.misses);
    activeSignals = r.activeSignals;
    initialExpanded = sc.ui?.tree?.expanded
      ? resolveExpanded(idx, sc.ui.tree.expanded)
      : new Set(INITIAL_EXPANDED_PATHS.map((p) => lookupByPath(hierarchy, p)));
  } else {
    activeSignals = defaultActiveSignals(hierarchy);
    initialExpanded = new Set(INITIAL_EXPANDED_PATHS.map((p) => lookupByPath(hierarchy, p)));
  }

  SCENE_PACK_SPECS = specsFromActive(hierarchy, activeSignals);
  return { hierarchy, activeSignals, initialExpanded };
}

// Load the sidecar once at module init (before App.tsx's module-load consts read
// SCENE.activeSignals). Non-fatal: a missing/bad file -> curated default scene.
const SIDECAR = loadSidecar(sidecarPath());

export const SCENE = buildScene(SIDECAR);

// Cursor / markers / time window / UI chrome initial values — from the sidecar
// when present, else fresh defaults.
export const INITIAL: InitialState = SIDECAR
  ? initialFromSidecar(SIDECAR, MOCK_END_TICKS)
  : freshInitial(MOCK_END_TICKS);

// Reset is held high from tick 0 until async deassertion at the first clock
// falling edge (tick 10). Exposed for overlay rendering.
export const RESET_HELD_TICKS = { tStart: 0, tEnd: 10 };
