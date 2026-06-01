import { HierarchyBuilder } from "./hierarchy";
import type { Hierarchy, NodeId } from "./types";
import {
  buildClockSegments,
  buildDataSignal,
  buildSegments,
  MOCK_END_TICKS,
  type SegValue,
  type Segment,
} from "../gpu/data";

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

function buildMock(): MockScene {
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

  // Rendered mock signals live under a dedicated sub-scope.
  const waves = b.openScope("waves", "module"); expanded.push(waves);
  const clk_id         = wire("clk", 1);
  const rst_id         = reg("rst", 1);
  const state_id       = reg("state[1:0]", 2, { enumTypeId: 1 });
  const cycle_id       = reg("cycle_count[7:0]", 8);
  const in_valid_id    = reg("in_valid", 1);
  const in_data_id     = reg("in_data[7:0]", 8);
  const in_addr_id     = reg("in_addr[15:0]", 16);
  const out_valid_id   = reg("out_valid", 1);
  const out_data_id    = reg("out_data[31:0]", 32);
  const fifo_level_id  = reg("fifo_level[3:0]", 4);
  const fifo_empty_id  = wire("fifo_empty", 1);
  const dbus_id        = wire("dbus[7:0]", 8);
  b.closeScope(); // waves

  b.closeScope(); // keysched

  b.openScope("mem_ctrl", "module"); b.closeScope();
  b.openScope("dma", "module"); b.closeScope();
  b.openScope("uart", "module"); b.closeScope();
  b.closeScope(); // top

  // User-derived signals in their own root scope.
  const derived = b.openScope("derived", "package"); expanded.push(derived);
  const busy_id = wire("busy", 1);
  const done_id = wire("done", 1);
  b.closeScope();

  const W = "top.keysched.waves";
  const activeSignals: ActiveSignalRef[] = [
    { signalId: clk_id,        row: 0,  radix: "bin", role: "clock", pinned: true, color: "#72F5DF", path: `${W}.clk`,               vcdType: "net" },
    { signalId: rst_id,        row: 1,  radix: "bin", role: "reset",                color: "#F06B5B", path: `${W}.rst`,               vcdType: "reg" },
    { signalId: state_id,      row: 2,  radix: "dec", selected: true,               color: "#B48CFF", path: `${W}.state[1:0]`,        vcdType: "reg" },
    { signalId: cycle_id,      row: 3,  radix: "dec",                               color: "#B48CFF", path: `${W}.cycle_count[7:0]`,  vcdType: "reg" },
    { signalId: in_valid_id,   row: 4,  radix: "bin", role: "valid",                color: "#F4A698", path: `${W}.in_valid`,          vcdType: "reg" },
    { signalId: in_data_id,    row: 5,  radix: "hex",                               color: "#F4A698", path: `${W}.in_data[7:0]`,      vcdType: "reg" },
    { signalId: in_addr_id,    row: 6,  radix: "hex",                               color: "#F4A698", path: `${W}.in_addr[15:0]`,     vcdType: "reg" },
    { signalId: out_valid_id,  row: 7,  radix: "bin", role: "valid",                color: "#57C88A", path: `${W}.out_valid`,         vcdType: "reg" },
    { signalId: out_data_id,   row: 8,  radix: "hex",                               color: "#57C88A", path: `${W}.out_data[31:0]`,    vcdType: "reg" },
    { signalId: fifo_level_id, row: 9,  radix: "dec",                               color: "#E6B14E", path: `${W}.fifo_level[3:0]`,   vcdType: "reg" },
    { signalId: fifo_empty_id, row: 10, radix: "bin",                               color: "#E6B14E", path: `${W}.fifo_empty`,        vcdType: "net" },
    { signalId: dbus_id,       row: 11, radix: "hex",                               color: "#4FD2BD", path: `${W}.dbus[7:0]`,         vcdType: "net" },
    { signalId: busy_id,       row: 12, radix: "bin", derivedExpr: "in_valid | out_valid", color: "#4FD2BD", path: "derived.busy", vcdType: "derived" },
    { signalId: done_id,       row: 13, radix: "bin", derivedExpr: "state == DONE",       color: "#4FD2BD", path: "derived.done", vcdType: "derived" },
  ];

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
    hierarchy: b.build(),
    activeSignals,
    initialExpanded: new Set(expanded),
    segments,
  };
}

export const MOCK_SCENE = buildMock();

// Reset is held high from tick 0 until asynchronous deassertion at the first
// clock falling edge (tick 10). Exposed for overlay rendering.
export const RESET_HELD_TICKS = { tStart: 0, tEnd: 10 };
