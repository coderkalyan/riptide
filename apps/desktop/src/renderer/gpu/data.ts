export interface Segment {
  tStart: number;  // nanoseconds (integer)
  tEnd: number;
  // LSBs of the segment value bitstring (0/1).
  valueLsb: number;
  // MSBs of the segment value bitstring (x/z).
  valueMsb: number;
  // Packed row/flags:
  // [15:0] row index
  // [  16] shade
  // [  17] right edge
  // [  18] rising edge
  // [  19] falling edge
  // [  20] mute segment
  rowFlags: number;
}

// Viewport describing the visible time window and canvas dimensions.
// Passed to the GPU as a uniform buffer each frame.
export interface Viewport {
  // Number of ticks per pixel (f32).
  ticks_per_pixel: number;
  // Leftmost visible tick (u32).
  start_ticks: number;
  // Size in pixels of the canvas, before DPR (f32).
  width: number;
  height: number;
  // Height of each signal row, in pixels (f32).
  row_height: number;
  // devicePixelRatio for HiDPI (f32).
  dpr: number;
  // Selected row (optional, -1 if not selected).
  selected_row: number;
}

// ---- hardcoded signals ------------------------------------------------
type LogicState = "0" | "1" | "x" | "z";
export const MOCK_CLOCK_TICK_NS = 5;
export const MOCK_END_TICKS = 90;

const FLAG_SHADE = 1 << 16;
const FLAG_RIGHT_EDGE = 1 << 17;
const FLAG_RISING_EDGE = 1 << 18;
const FLAG_FALLING_EDGE = 1 << 19;
const FLAG_MUTE = 1 << 20;

function maskForWidth(width: number): number {
  if (width <= 0 || width > 32) throw new Error(`Invalid bit width: ${width}`);
  if (width === 32) return 0xffffffff;
  return (1 << width) - 1;
}

function logicToBits(state: LogicState, width: number): { valueLsb: number; valueMsb: number } {
  const ones = maskForWidth(width);
  if (state === "0") return { valueLsb: 0, valueMsb: 0 };
  if (state === "1") return { valueLsb: ones, valueMsb: 0 };
  if (state === "x") return { valueLsb: 0, valueMsb: ones };
  return { valueLsb: ones, valueMsb: ones }; // z
}

function buildRowFlags(
  row: number,
  opts: {
    shaded: boolean;
    rightEdge: boolean;
    risingEdge: boolean;
    fallingEdge: boolean;
    muted?: boolean;
  },
): number {
  return (
    (row & 0xffff) |
    (opts.shaded ? FLAG_SHADE : 0) |
    (opts.rightEdge ? FLAG_RIGHT_EDGE : 0) |
    (opts.risingEdge ? FLAG_RISING_EDGE : 0) |
    (opts.fallingEdge ? FLAG_FALLING_EDGE : 0) |
    (opts.muted ? FLAG_MUTE : 0)
  );
}

function buildSegmentsFromStates(
  row: number,
  states: LogicState[],
  width: number,
  segmentUnits: number[],
  shaded: boolean,
  opts?: {
    clockEdges?: boolean;
    edgeOnlyBinaryTransitions?: boolean;
    muteMask?: boolean[];
  },
): Segment[] {
  if (states.length !== segmentUnits.length) {
    throw new Error(`states/segmentUnits length mismatch for row ${row}`);
  }
  const clockEdges = !!opts?.clockEdges;
  const edgeOnlyBinaryTransitions = !!opts?.edgeOnlyBinaryTransitions;
  const muteMask = opts?.muteMask;
  let tick = 0;
  const segments = states.map((state, index) => {
    const next = states[index + 1];
    const start = tick;
    const end = tick + segmentUnits[index] * MOCK_CLOCK_TICK_NS;
    tick = end;

    const risingEdge = clockEdges && state === "0" && next === "1";
    const fallingEdge = false;
    const isBinaryTransition = !!next && ((state === "0" && next === "1") || (state === "1" && next === "0"));
    const rightEdge = index < states.length - 1 && (!edgeOnlyBinaryTransitions || isBinaryTransition);
    return {
      tStart: start,
      tEnd: end,
      ...logicToBits(state, width),
      rowFlags: buildRowFlags(row, {
        shaded,
        rightEdge,
        risingEdge,
        fallingEdge,
        muted: muteMask ? muteMask[index] : false,
      }),
    };
  });
  if (tick !== MOCK_END_TICKS) {
    throw new Error(`Row ${row} does not end at ${MOCK_END_TICKS}ns (got ${tick}ns)`);
  }
  return segments;
}

// Sequence covers all ordered back-to-back pairs in [0,1,x,z] except repeats.
const ALL_TRANSITIONS_SINGLE: LogicState[] = ["0", "1", "0", "x", "0", "z", "1", "x", "1", "z", "x", "z", "0"];
const CLOCK_SEQUENCE: LogicState[] = Array.from({ length: MOCK_END_TICKS / MOCK_CLOCK_TICK_NS }, (_, i) => (i % 2 === 0 ? "0" : "1"));
const DURS_A = [1, 2, 1, 1, 2, 1, 1, 2, 1, 1, 2, 1, 2];
const DURS_B = [2, 1, 1, 2, 1, 1, 2, 1, 1, 2, 1, 1, 2];
const DURS_C = [1, 1, 2, 1, 2, 1, 1, 2, 1, 2, 1, 1, 2];
const DURS_CLOCK = Array.from({ length: CLOCK_SEQUENCE.length }, () => 1);

export const MOCK_SINGLE_BIT_SEGMENTS: Segment[] = [
  ...buildSegmentsFromStates(0, CLOCK_SEQUENCE, 1, DURS_CLOCK, false, { clockEdges: true, edgeOnlyBinaryTransitions: true }), // clock (top row)
  ...buildSegmentsFromStates(1, ALL_TRANSITIONS_SINGLE, 1, DURS_A, true, { edgeOnlyBinaryTransitions: true }),
  ...buildSegmentsFromStates(2, ALL_TRANSITIONS_SINGLE, 1, DURS_B, true, { edgeOnlyBinaryTransitions: true }),
  ...buildSegmentsFromStates(3, ALL_TRANSITIONS_SINGLE, 1, DURS_C, true, { edgeOnlyBinaryTransitions: true }),
];

export const MOCK_MULTI_BIT_SEGMENTS: Segment[] = [
  ...buildSegmentsFromStates(4, ALL_TRANSITIONS_SINGLE, 2, DURS_A, true),
  ...buildSegmentsFromStates(5, ALL_TRANSITIONS_SINGLE, 4, DURS_B, true),
  ...buildSegmentsFromStates(6, ALL_TRANSITIONS_SINGLE, 8, DURS_C, true),
  ...buildSegmentsFromStates(7, ALL_TRANSITIONS_SINGLE, 12, DURS_A, true),
];

// valid / data / bit group: rows 8-10, all transitions locked to rising clock edges.
// Rising edges at 5,15,25,35,45,55,65,75,85 ns → durations [1,2,2,2,2,2,2,2,2,1] × 5ns = 90ns.
const VD_DURS = [1, 2, 2, 2, 2, 2, 2, 2, 2, 1];

// valid (row 8): controls muting for rows 9 and 10.
const VD_VALID: LogicState[] = ["0", "0", "1", "1", "0", "1", "0", "1", "0", "0"];
const VD_MUTE = VD_VALID.map((s) => s !== "1");

// 8-bit data (row 9): mix of x/z so muted and non-muted variants are both visible.
//   muted x/z at indices: 0(x), 4(x), 8(z)   (valid=0)
//   live  x/z at indices: 2(z), 5(z), 7(x)   (valid=1)
const VD_DATA_8B: LogicState[] = ["x", "0", "z", "1", "x", "z", "1", "x", "z", "0"];

// 1-bit signal (row 10): alternating 0/1 to show muted single-bit behaviour.
const VD_BIT_1B: LogicState[] = ["1", "0", "1", "0", "1", "0", "1", "0", "1", "0"];

export const MOCK_VALID_DATA_SEGMENTS: Segment[] = [
  ...buildSegmentsFromStates(8, VD_VALID, 1, VD_DURS, true, { edgeOnlyBinaryTransitions: true }),
  ...buildSegmentsFromStates(9, VD_DATA_8B, 8, VD_DURS, true, { muteMask: VD_MUTE }),
  ...buildSegmentsFromStates(10, VD_BIT_1B, 1, VD_DURS, true, { edgeOnlyBinaryTransitions: true, muteMask: VD_MUTE }),
];

export const HARDCODED_SEGMENTS: Segment[] = [
  ...MOCK_SINGLE_BIT_SEGMENTS,
  ...MOCK_MULTI_BIT_SEGMENTS,
  ...MOCK_VALID_DATA_SEGMENTS,
];

// ---- GPU packing -------------------------------------------------------
// Layout: each segment = 5 × u32 = 20 bytes
//   [0] tStart  [1] tEnd  [2] valueLsb  [3] valueMsb  [4] rowFlags
// Matches the storage buffer struct in the WGSL shader.

export function packSegments(segs: Segment[]): Uint32Array {
  const buf = new Uint32Array(segs.length * 5);
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i];
    buf[i * 5 + 0] = s.tStart;
    buf[i * 5 + 1] = s.tEnd;
    buf[i * 5 + 2] = s.valueLsb;
    buf[i * 5 + 3] = s.valueMsb;
    buf[i * 5 + 4] = s.rowFlags;
  }
  return buf;
}

// Viewport packed as (6 + 2) × f32 = 32 bytes (multiple of 16, required by WebGPU).
export function packViewport(vp: Viewport): Float32Array {
  return new Float32Array([
    vp.ticks_per_pixel,
    vp.start_ticks,
    vp.width,
    vp.height,
    vp.row_height,
    vp.dpr,
    vp.selected_row,

    // Padding.
    0.0,
  ]);
}
