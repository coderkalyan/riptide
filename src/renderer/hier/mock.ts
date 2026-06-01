import { HierarchyBuilder, getScope } from "./hierarchy";
import type { Hierarchy, NodeId, Signal } from "./types";
import { pathOf } from "./types";
import {
  buildClockSegments,
  buildDataSignal,
  buildSegments,
  MOCK_END_TICKS,
  type SegValue,
  type Segment,
} from "../gpu/data";
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

// VCD variable kind shown in the row tooltip. Mock for now (no VCD loader);
// "derived" covers user expressions that aren't backed by a real VCD var.
export type VcdType = "net" | "reg" | "derived";

export interface ActiveSignalRef {
  signalId: NodeId;
  row: number;
  radix: Radix;
  color: string;           // CSS hex, e.g. "#72F5DF"
  path: string;            // full dotted path, e.g. "top.keysched.waves.clk"
  vcdType: VcdType;        // VCD variable kind (mock; see VcdType)
  pinned?: boolean;
  selected?: boolean;
  hidden?: boolean;        // eye toggled off; cosmetic only (no canvas effect yet)
  role?: ActiveRole;
  derivedExpr?: string;
}

export interface MockScene {
  hierarchy: Hierarchy;
  activeSignals: ActiveSignalRef[];
  initialExpanded: Set<NodeId>;
  segments: Segment[];
}

// ---- waveform values per cycle (10 cycles) -----------------------------
// Values align to rising clock edges. Index 0 = pre-first-rising-edge (X for
// uninitialized regs). rst asserted high for cycles 0-1, deasserts at edge 2.

// Values are per rising-edge cycle; index 0 = pre-first-rising-edge.
// Reset is asynchronously deasserted at the first falling edge (tick 10), so
// registers stay X through cycles 0 and 1 and only become clean at cycle 2.
// State enum: IDLE=0, BUSY=1, WAIT=2 (see state_t enum below).
const V_STATE:       SegValue[] = [  "x",  "x",    0,      0,      1,          2,          2,          1,          0,     0];
const V_CYCLE:       SegValue[] = [  "x",  "x",    0,      1,      2,          3,          4,          5,          6,     7];
const V_IN_VALID:    SegValue[] = [    0,    0,    0,      1,      1,          0,          1,          1,          0,     0];
const V_IN_DATA:     SegValue[] = [  "x",  "x",  "x",   0xA3,   0xA3,        "x",       0xB7,       0xB7,        "x",   "x"];
const V_IN_ADDR:     SegValue[] = [  "x",  "x",  "x", 0x1000, 0x1004,        "x",     0x1008,     0x100C,        "x",   "x"];
const V_OUT_VALID:   SegValue[] = [    0,    0,    0,      0,      0,          1,          1,          1,          1,     0];
const V_OUT_DATA:    SegValue[] = [  "x",  "x",  "x",    "x",    "x", 0xDEADBEEF, 0xDEADBEEF, 0xCAFEB0BA, 0xCAFEB0BA,   "x"];
const V_FIFO_LEVEL:  SegValue[] = [  "x",  "x",    0,      1,      2,          2,          2,          1,          0,     0];
const V_FIFO_EMPTY:  SegValue[] = [  "x",  "x",    1,      0,      0,          0,          0,          0,          1,     1];
const V_DBUS:        SegValue[] = [  "x",  "x",  "z",   0x55,   0x55,        "z",       0xF0,       0xF0,        "z",   "z"];
const V_BUSY:        SegValue[] = [    0,    0,    0,      1,      1,          1,          1,          1,          1,     0];
const V_DONE:        SegValue[] = [    0,    0,    0,      0,      0,          0,          0,          0,          1,     0];

const MUTE_IN = V_IN_VALID.map((v) => v !== 1);
const MUTE_OUT = V_OUT_VALID.map((v) => v !== 1);

// ---- scene --------------------------------------------------------------

// Default row colors for the fresh (no-sidecar) view, cycled by row.
const DEFAULT_SIGNAL_COLORS = [
  "#72F5DF", "#F06B5B", "#B48CFF", "#E6B14E", "#F4A698", "#57C88A", "#4FD2BD", "#727BF5",
];

// "Fresh VCD" signal list: every signal under the given scopes, in declaration
// order, with default radix/color and no presentation overlay. Reproduces rows
// 0..N so the native row-indexed segments still line up.
function freshActiveSignals(h: Hierarchy, scopeIds: NodeId[]): ActiveSignalRef[] {
  const out: ActiveSignalRef[] = [];
  let row = 0;
  for (const scopeId of scopeIds) {
    for (const childId of getScope(h, scopeId).children) {
      const node = h.nodes.get(childId);
      if (!node || node.kind !== "signal") continue;
      const sig = node as Signal;
      out.push({
        signalId: childId,
        row,
        radix: sig.bitWidth === 1 ? "bin" : "hex",
        color: DEFAULT_SIGNAL_COLORS[row % DEFAULT_SIGNAL_COLORS.length],
        path: pathOf(h, childId),
        vcdType: sig.varType === "vcd_reg" ? "reg" : "net",
      });
      row++;
    }
  }
  return out;
}

function buildMock(sc: Sidecar | null): MockScene {
  const b = new HierarchyBuilder().setFormat("fst").setTimescale({ value: 1, unit: "ns", precision: { value: 10, unit: "ps" } });
  const expanded: NodeId[] = [];
  let handleCounter = 0;
  const h = () => `!${(handleCounter++).toString(36)}`;
  const wire = (name: string, bitWidth: number, extra?: { enumTypeId?: number }) =>
    b.addSignal({ name, varType: "vcd_wire", bitWidth, handle: h(), direction: "implicit", ...extra });
  const reg = (name: string, bitWidth: number, extra?: { enumTypeId?: number }) =>
    b.addSignal({ name, varType: "vcd_reg", bitWidth, handle: h(), direction: "implicit", ...extra });

  b.addEnumType({
    id: 1,
    name: "state_t",
    members: [
      { raw: "00", label: "IDLE" },
      { raw: "01", label: "BUSY" },
      { raw: "10", label: "WAIT" },
    ],
  });

  const top = b.openScope("top", "module"); expanded.push(top);

  b.openScope("des", "module"); b.closeScope();

  const keysched = b.openScope("keysched", "module"); expanded.push(keysched);
  // Navigation signals (hierarchy-only, no waveform data).
  wire("clk", 1);
  wire("rst_n", 1);
  wire("c[10:0]", 11);
  wire("load1[0:8]", 9);
  wire("load2[0:8]", 9);
  wire("load3[0:8]", 9);
  wire("data[31:0]", 32);
  wire("state[1:0]", 2, { enumTypeId: 1 });
  b.openScope("fsm", "module"); b.closeScope();
  b.openScope("xbar", "module"); b.closeScope();

  // Rendered mock signals live under a dedicated sub-scope. Declaration order
  // here defines rows 0..11 (then derived busy/done are 12/13), which the
  // native row-indexed segments depend on — keep them in sync.
  const waves = b.openScope("waves", "module"); expanded.push(waves);
  wire("clk", 1);
  reg("rst", 1);
  reg("state[1:0]", 2, { enumTypeId: 1 });
  reg("cycle_count[7:0]", 8);
  reg("in_valid", 1);
  reg("in_data[7:0]", 8);
  reg("in_addr[15:0]", 16);
  reg("out_valid", 1);
  reg("out_data[31:0]", 32);
  reg("fifo_level[3:0]", 4);
  wire("fifo_empty", 1);
  wire("dbus[7:0]", 8);
  b.closeScope(); // waves

  b.closeScope(); // keysched

  b.openScope("mem_ctrl", "module"); b.closeScope();
  b.openScope("dma", "module"); b.closeScope();
  b.openScope("uart", "module"); b.closeScope();
  b.closeScope(); // top

  // User-derived signals in their own root scope.
  const derived = b.openScope("derived", "package"); expanded.push(derived);
  wire("busy", 1);
  wire("done", 1);
  b.closeScope();

  const hierarchy = b.build();

  // Viewer state (which signals, in what order, how styled + the tree
  // expansion) comes from the sidecar when one exists; otherwise we show a
  // "fresh VCD": every waved signal in declaration order, plainly styled.
  const idx = buildPathIndex(hierarchy);
  let activeSignals: ActiveSignalRef[];
  let initialExpanded: Set<NodeId>;
  if (sc) {
    const r = resolveView(hierarchy, idx, sc.view);
    if (r.misses.length) console.warn("[sidecar] unresolved signal paths (skipped):", r.misses);
    activeSignals = r.activeSignals;
    initialExpanded = sc.ui?.tree?.expanded
      ? resolveExpanded(idx, sc.ui.tree.expanded)
      : new Set(expanded);
  } else {
    activeSignals = freshActiveSignals(hierarchy, [waves, derived]);
    initialExpanded = new Set(expanded);
  }

  const segments: Segment[] = [
    ...buildClockSegments(0),
    // rst: high from 0, deasserts at the first clock falling edge (tick 10).
    ...buildSegments(1, 1, [
      { tStart: 0,  tEnd: 10, value: 1 },
      { tStart: 10, tEnd: MOCK_END_TICKS, value: 0 },
    ]),
    ...buildDataSignal({ row: 2,  bitWidth: 2,  values: V_STATE }),
    ...buildDataSignal({ row: 3,  bitWidth: 8,  values: V_CYCLE }),
    ...buildDataSignal({ row: 4,  bitWidth: 1,  values: V_IN_VALID }),
    ...buildDataSignal({ row: 5,  bitWidth: 8,  values: V_IN_DATA,    muted: MUTE_IN }),
    ...buildDataSignal({ row: 6,  bitWidth: 16, values: V_IN_ADDR,    muted: MUTE_IN }),
    ...buildDataSignal({ row: 7,  bitWidth: 1,  values: V_OUT_VALID }),
    ...buildDataSignal({ row: 8,  bitWidth: 32, values: V_OUT_DATA,   muted: MUTE_OUT }),
    ...buildDataSignal({ row: 9,  bitWidth: 4,  values: V_FIFO_LEVEL }),
    ...buildDataSignal({ row: 10, bitWidth: 1,  values: V_FIFO_EMPTY }),
    ...buildDataSignal({ row: 11, bitWidth: 8,  values: V_DBUS }),
    ...buildDataSignal({ row: 12, bitWidth: 1,  values: V_BUSY }),
    ...buildDataSignal({ row: 13, bitWidth: 1,  values: V_DONE }),
  ];

  return {
    hierarchy,
    activeSignals,
    initialExpanded,
    segments,
  };
}

// Load the sidecar once at module init (before App.tsx's module-load consts
// read MOCK_SCENE.activeSignals). Non-fatal: a missing/bad file -> fresh view.
const SIDECAR = loadSidecar(sidecarPath());

export const MOCK_SCENE = buildMock(SIDECAR);

// Cursor / markers / time window / UI chrome initial values — from the sidecar
// when present, else fresh defaults.
export const INITIAL: InitialState = SIDECAR
  ? initialFromSidecar(SIDECAR, MOCK_END_TICKS)
  : freshInitial(MOCK_END_TICKS);

// Reset is held high from tick 0 until asynchronous deassertion at the first
// clock falling edge (tick 10). Exposed for overlay rendering.
export const RESET_HELD_TICKS = { tStart: 0, tEnd: 10 };
