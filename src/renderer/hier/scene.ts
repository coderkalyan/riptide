import type { EnumType, Hierarchy, NodeId, Scope, Signal, VarType } from "./types";
import { pathOf } from "./types";
import { getSignal } from "./hierarchy";
import { getHierarchy, loadVcd, type NativePackSpec } from "../native";
import { stamp, setHierarchyNodes, swapMark } from "../perf";
import { MOCK_END_TICKS } from "../gpu/data";
import { VCD_PATH } from "../runtime";
import {
  buildPathIndex,
  freshInitial,
  initialFromSidecar,
  loadSidecar,
  resolveExpanded,
  resolveView,
  setCurrentSidecarPath,
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
// Each row binds to a signal by its full hierarchy `path`; the tide handle is
// resolved from the loaded VCD hierarchy at scene-build time (tide-vcd assigns
// ids in declaration order, so we can't hardcode them). Everything else here is
// presentation metadata that the VCD does not carry, overlaid onto the node.

interface RowConfig {
  row: number;
  radix: Radix;
  color: string;
  vcdType: VcdType;
  pinned?: boolean;
  selected?: boolean;
  role?: ActiveRole;
  derivedExpr?: string;
  gatePath?: string;         // mute this row when the gate signal isn't logic-1
  enumTypeId?: number;       // overlay onto the signal node (tide lacks enums)
}

const W = "top.keysched.waves";
const ROWS: (RowConfig & { path: string })[] = [
  { row: 0,  radix: "bin", role: "clock", pinned: true,                 color: "#72F5DF", path: `${W}.clk`,              vcdType: "net" },
  { row: 1,  radix: "bin", role: "reset",                               color: "#F06B5B", path: `${W}.rst`,              vcdType: "reg" },
  { row: 2,  radix: "dec", selected: true, enumTypeId: 1,               color: "#B48CFF", path: `${W}.state[1:0]`,       vcdType: "reg" },
  { row: 3,  radix: "dec",                                              color: "#B48CFF", path: `${W}.cycle_count[7:0]`, vcdType: "reg" },
  { row: 4,  radix: "bin", role: "valid",                               color: "#F4A698", path: `${W}.in_valid`,         vcdType: "reg" },
  { row: 5,  radix: "hex", gatePath: `${W}.in_valid`,                   color: "#F4A698", path: `${W}.in_data[7:0]`,     vcdType: "reg" },
  { row: 6,  radix: "hex", gatePath: `${W}.in_valid`,                   color: "#F4A698", path: `${W}.in_addr[15:0]`,    vcdType: "reg" },
  { row: 7,  radix: "bin", role: "valid",                               color: "#57C88A", path: `${W}.out_valid`,        vcdType: "reg" },
  { row: 8,  radix: "hex", gatePath: `${W}.out_valid`,                  color: "#57C88A", path: `${W}.out_data[31:0]`,   vcdType: "reg" },
  { row: 9,  radix: "dec",                                              color: "#E6B14E", path: `${W}.fifo_level[3:0]`,  vcdType: "reg" },
  { row: 10, radix: "bin",                                              color: "#E6B14E", path: `${W}.fifo_empty`,       vcdType: "net" },
  { row: 11, radix: "hex",                                              color: "#4FD2BD", path: `${W}.dbus[7:0]`,        vcdType: "net" },
  { row: 12, radix: "bin", derivedExpr: "in_valid | out_valid",         color: "#4FD2BD", path: "derived.busy",         vcdType: "derived" },
  { row: 13, radix: "bin", derivedExpr: "state == DONE",                color: "#4FD2BD", path: "derived.done",         vcdType: "derived" },
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

function signalAt(h: Hierarchy, path: string): Signal {
  const node = h.nodes.get(lookupByPath(h, path));
  if (!node || node.kind !== "signal") throw new Error(`Not a signal: ${path}`);
  return node;
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

// Gate signal path keyed by the gated signal's path. Trace semantics (mute a
// row while its gate isn't logic-1), applied whether active signals come from a
// sidecar or the curated default — so the sidecar never has to carry gate info.
const GATE_BY_PATH = new Map<string, string>();
for (const r of ROWS) if (r.gatePath) GATE_BY_PATH.set(r.path, r.gatePath);

// Native pack specs from the active signal list — what tide should query + how
// to pack each row. kind/shade from role; gate is path-keyed, handle resolved
// from the loaded hierarchy.
function specsFromActive(h: Hierarchy, active: ActiveSignalRef[]): NativePackSpec[] {
  return active.map((s) => {
    const gatePath = GATE_BY_PATH.get(s.path);
    return {
      row: s.row,
      handle: signalAt(h, s.path).handle,
      kind: s.role === "clock" ? "clk" : "data",
      shaded: s.role !== "clock",
      gateHandle: gatePath ? signalAt(h, gatePath).handle : null,
    };
  });
}

// Computed in buildScene from the active signal list; returned to App.tsx, which
// feeds it to getMockSegments.
let SCENE_PACK_SPECS: NativePackSpec[] = [];
export function buildPackSpecs(): NativePackSpec[] {
  return SCENE_PACK_SPECS;
}

// Pack specs for an arbitrary active list against the loaded scene hierarchy.
// Used when the active set changes at runtime (add-from-tree) to repack the GPU
// buffers without rebuilding the whole scene.
export function packSpecsFor(active: ActiveSignalRef[]): NativePackSpec[] {
  return specsFromActive(SCENE.hierarchy, active);
}

// reg-like VCD var types render as "reg" in the row tooltip; everything else as
// a net. Derived signals carry their own vcdType and never come through here.
function vcdTypeOf(varType: VarType): VcdType {
  switch (varType) {
    case "vcd_reg":
    case "vcd_integer":
    case "vcd_time":
    case "vcd_trireg":
    case "sv_logic":
    case "sv_bit":
    case "sv_int":
    case "sv_shortint":
    case "sv_longint":
    case "sv_byte":
    case "sv_enum":
      return "reg";
    default:
      return "net";
  }
}

// Default presentation metadata for a signal newly added from the tree. Buses
// default to hex, scalars to bin; color cycles a palette by row so adjacent adds
// read apart.
const ADD_PALETTE = ["#72F5DF", "#B48CFF", "#F4A698", "#57C88A", "#E6B14E", "#4FD2BD", "#F06B5B", "#727BF5"];
export function makeActiveRef(h: Hierarchy, signalId: NodeId, row: number): ActiveSignalRef {
  const sig = getSignal(h, signalId);
  return {
    signalId,
    row,
    radix: sig.bitWidth > 1 ? "hex" : "bin",
    color: ADD_PALETTE[row % ADD_PALETTE.length],
    path: pathOf(h, signalId),
    vcdType: vcdTypeOf(sig.varType),
  };
}

function buildScene(sc: Sidecar | null): Scene {
  stamp("scene:start");
  const hierarchy = getHierarchy();
  stamp("scene:hierarchy");
  setHierarchyNodes(hierarchy.nodes.size);

  // Overlay TS-only metadata that the VCD/tide hierarchy doesn't carry. Enum
  // association is keyed by path, independent of the sidecar.
  hierarchy.timescale = { value: 1, unit: "ns", precision: { value: 10, unit: "ps" } };
  for (const t of ENUM_TYPES) hierarchy.enumTypes.set(t.id, t);
  for (const r of ROWS) {
    if (r.enumTypeId == null) continue;
    // Keyed by path; applies only when this trace actually has the signal (a
    // fresh/arbitrary VCD won't), so resolve defensively.
    try { signalAt(hierarchy, r.path).enumTypeId = r.enumTypeId; } catch { /* not in this trace */ }
  }
  // tide-vcd has no `package` scope kind, so the VCD declares `derived` as a
  // module; restore the package styling the UI expects (shim — see
  // TIDE_INTEGRATION.md).
  for (const id of hierarchy.rootIds) {
    const node = hierarchy.nodes.get(id);
    if (node && node.kind === "scope" && node.name === "derived") node.scopeType = "package";
  }

  // Active signals + tree expansion come from the sidecar when one exists next
  // to the trace (e.g. the bundled mock); a fresh trace opens with nothing
  // active. Unresolved sidecar paths are skipped (non-fatal).
  let activeSignals: ActiveSignalRef[];
  let initialExpanded: Set<NodeId>;
  if (sc) {
    const idx = buildPathIndex(hierarchy);
    const r = resolveView(hierarchy, idx, sc.view);
    if (r.misses.length) console.warn("[sidecar] unresolved signal paths (skipped):", r.misses);
    activeSignals = r.activeSignals;
    initialExpanded = sc.ui?.tree?.expanded
      ? resolveExpanded(idx, sc.ui.tree.expanded)
      : new Set(hierarchy.rootIds);
  } else {
    // Fresh trace: no sidecar -> nothing active yet (add-from-tree isn't wired).
    activeSignals = [];
    initialExpanded = new Set(hierarchy.rootIds);
  }

  SCENE_PACK_SPECS = specsFromActive(hierarchy, activeSignals);
  stamp("scene:end");
  return { hierarchy, activeSignals, initialExpanded };
}

// The trace currently loaded in the renderer. Seeded from the window URL; updated
// by swapTrace on an in-app "Open VCD…".
let CURRENT_VCD_PATH = VCD_PATH;
export function currentVcdPath(): string { return CURRENT_VCD_PATH; }

// Load the sidecar once at module init (before App.tsx's module-load consts read
// SCENE.activeSignals). Non-fatal: a missing/bad file -> curated default scene.
// SCENE/INITIAL/SIDECAR are `let` (not const) so swapTrace can reassign them; ES
// live bindings propagate the new value to every `import { SCENE, INITIAL }`
// site (re-read at render/effect time), so the in-app trace swap needs no reload.
let SIDECAR = loadSidecar(sidecarPath());

export let SCENE = buildScene(SIDECAR);

// Cursor / markers / time window / UI chrome initial values — from the sidecar
// when present, else fresh defaults.
export let INITIAL: InitialState = SIDECAR
  ? initialFromSidecar(SIDECAR, MOCK_END_TICKS)
  : freshInitial(MOCK_END_TICKS);

// Reset is held high from tick 0 until async deassertion at the first clock
// falling edge (tick 10). Exposed for overlay rendering.
export const RESET_HELD_TICKS = { tStart: 0, tEnd: 10 };

// Swap the loaded trace in place (no window reload). Recomputes the whole trace
// layer — native db, sidecar, SCENE (hierarchy + active signals + pack specs),
// and INITIAL — so the caller (App.resetForTrace) can re-seed React state + force
// a GPU repack. Synchronous; native.loadVcd blocks until the db is swapped.
export function swapTrace(vcdPath: string): void {
  // Marks are emitted AFTER each step so each phase label measures the work just
  // completed (the finalize differences consecutive marks).
  loadVcd(vcdPath);
  swapMark("native loadVcd");                  // tide parse + db swap (FFI)
  CURRENT_VCD_PATH = vcdPath;
  setCurrentSidecarPath(vcdPath);
  SIDECAR = loadSidecar(sidecarPath());
  swapMark("load sidecar");                     // read + parse <trace>.sidecar.json
  SCENE = buildScene(SIDECAR);                   // getHierarchy FFI + marshal + resolve
  swapMark("buildScene (hierarchy + resolve)");
  INITIAL = SIDECAR ? initialFromSidecar(SIDECAR, MOCK_END_TICKS) : freshInitial(MOCK_END_TICKS);
}
