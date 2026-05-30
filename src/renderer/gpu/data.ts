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
  // [  18] rising edge (caret left arm, at right boundary)
  // [  19] falling edge
  // [  20] mute segment
  // [  21] rising edge left (caret right arm, at left boundary)
  rowFlags: number;
}

// Viewport describing the visible time window and canvas dimensions.
// Passed to the GPU as a uniform buffer each frame.
export interface Viewport {
  ticks_per_pixel: number;
  // Pass start_ticks as a real number; writeViewportInto splits it into
  // integer (i32) + fractional (f32) parts for shader-side precision.
  start_ticks: number;
  width: number;
  height: number;
  row_height: number;
  dpr: number;
  selected_row: number;
  wave_y_offset: number;
}

export const MOCK_CLOCK_TICK_NS = 5;
export const MOCK_END_TICKS = 90;

// 10 cycle-aligned segments of durations summing to MOCK_END_TICKS / MOCK_CLOCK_TICK_NS = 18 half-ticks.
// Rising edges at 5,15,25,35,45,55,65,75,85 ns — data changes only on rising edges.
export const CYCLE_DURS = [1, 2, 2, 2, 2, 2, 2, 2, 2, 1];

const FLAG_SHADE = 1 << 16;
const FLAG_RIGHT_EDGE = 1 << 17;
const FLAG_RISING_EDGE = 1 << 18;
// const FLAG_FALLING_EDGE = 1 << 19;  // unused
const FLAG_MUTE = 1 << 20;
const FLAG_RISING_EDGE_LEFT = 1 << 21;

export function maskForWidth(width: number): number {
  if (width <= 0 || width > 32) throw new Error(`Invalid bit width: ${width}`);
  if (width === 32) return 0xffffffff;
  return (1 << width) - 1;
}

export type SegValue = number | "x" | "z" | { lsb: number; msb: number };

function valueBits(v: SegValue, width: number): { lsb: number; msb: number } {
  const mask = maskForWidth(width);
  if (v === "x") return { lsb: 0, msb: mask };
  if (v === "z") return { lsb: mask, msb: mask };
  if (typeof v === "number") return { lsb: (v & mask) >>> 0, msb: 0 };
  return { lsb: (v.lsb & mask) >>> 0, msb: (v.msb & mask) >>> 0 };
}

function sameValue(a: SegValue, b: SegValue, width: number): boolean {
  const aa = valueBits(a, width);
  const bb = valueBits(b, width);
  return aa.lsb === bb.lsb && aa.msb === bb.msb;
}

export interface BuildDataSignalParams {
  row: number;
  bitWidth: number;
  values: SegValue[];          // length must equal CYCLE_DURS.length
  muted?: boolean[];           // per-cycle mute flag (e.g. !valid)
  shaded?: boolean;            // default true
}

// Build a data signal whose transitions align to rising clock edges.
// Consecutive cycles with the same value AND same mute flag coalesce into
// one segment — held signals emit a single wide rect, not N back-to-back ones.
export function buildDataSignal(p: BuildDataSignalParams): Segment[] {
  if (p.values.length !== CYCLE_DURS.length) {
    throw new Error(`row ${p.row}: expected ${CYCLE_DURS.length} values, got ${p.values.length}`);
  }
  const shaded = p.shaded ?? true;
  const muteAt = (i: number) => !!p.muted?.[i];
  const segs: Segment[] = [];
  let i = 0;
  let tick = 0;
  while (i < p.values.length) {
    const start = tick;
    let j = i;
    while (
      j + 1 < p.values.length &&
      sameValue(p.values[j], p.values[j + 1], p.bitWidth) &&
      muteAt(j + 1) === muteAt(i)
    ) {
      j++;
    }
    let end = start;
    for (let k = i; k <= j; k++) end += CYCLE_DURS[k] * MOCK_CLOCK_TICK_NS;
    const bits = valueBits(p.values[i], p.bitWidth);
    const hasNext = j + 1 < p.values.length;
    // Single-bit transitions involving x/z on either side have no meaningful
    // "edge": the renderer can't draw a clean 0→x flip the same way as a 0→1
    // flip. Suppress the right-edge flag on the left-side segment.
    let drawRightEdge = hasNext;
    if (drawRightEdge && p.bitWidth === 1) {
      const next = valueBits(p.values[j + 1], p.bitWidth);
      if (bits.msb !== 0 || next.msb !== 0) drawRightEdge = false;
    }
    segs.push({
      tStart: start,
      tEnd: end,
      valueLsb: bits.lsb,
      valueMsb: bits.msb,
      rowFlags:
        (p.row & 0xffff) |
        (shaded ? FLAG_SHADE : 0) |
        (drawRightEdge ? FLAG_RIGHT_EDGE : 0) |
        (muteAt(i) ? FLAG_MUTE : 0),
    });
    tick = end;
    i = j + 1;
  }
  return segs;
}

// Emit arbitrary-timed segments. Use when cycle alignment doesn't apply
// (e.g. async reset deassertion on a clock falling edge).
export interface RawSegmentSpec {
  tStart: number;
  tEnd: number;
  value: SegValue;
  muted?: boolean;
}
export function buildSegments(row: number, bitWidth: number, raw: RawSegmentSpec[], shaded = true): Segment[] {
  return raw.map((r, i) => {
    const bits = valueBits(r.value, bitWidth);
    const hasNext = i + 1 < raw.length;
    return {
      tStart: r.tStart,
      tEnd: r.tEnd,
      valueLsb: bits.lsb,
      valueMsb: bits.msb,
      rowFlags:
        (row & 0xffff) |
        (shaded ? FLAG_SHADE : 0) |
        (hasNext ? FLAG_RIGHT_EDGE : 0) |
        (r.muted ? FLAG_MUTE : 0),
    };
  });
}

// Alternating clock: one segment per half-period. Rising edge arrow on 0→1.
export function buildClockSegments(row: number): Segment[] {
  const half = MOCK_CLOCK_TICK_NS;
  const count = MOCK_END_TICKS / half;
  const segs: Segment[] = [];
  for (let i = 0; i < count; i++) {
    const val = i % 2;
    const start = i * half;
    const hasNext = i + 1 < count;
    const rising = val === 0 && hasNext;
    // High half-period draws the right arm of the rising-edge caret at its
    // left boundary (every val===1 segment follows a low one).
    const risingLeft = val === 1;
    segs.push({
      tStart: start,
      tEnd: start + half,
      valueLsb: val,
      valueMsb: 0,
      rowFlags:
        (row & 0xffff) |
        (hasNext ? FLAG_RIGHT_EDGE : 0) |
        (rising ? FLAG_RISING_EDGE : 0) |
        (risingLeft ? FLAG_RISING_EDGE_LEFT : 0),
    });
  }
  return segs;
}

// Viewport = 12 × 4 B = 48 bytes (multiple of 16, required by WebGPU). Mixed
// int/float fields per the WGSL Viewport struct: slot 1 (start_ticks_int) and
// slot 7 (selected_row) are i32; the rest are f32. Slots 9..11 are pad to hit
// 16-byte alignment. Caller provides aliased Float32 and Int32 views over the
// same ArrayBuffer so each slot is written with the correct bit pattern
// without per-frame allocation.
export const VIEWPORT_BYTES = 48;
export function writeViewportInto(f32: Float32Array, i32: Int32Array, vp: Viewport): void {
  // Split start_ticks into integer + fractional parts so shader subtraction
  // happens in i32 (full precision for tick values > 2^24).
  const startInt = Math.floor(vp.start_ticks);
  f32[0] = vp.ticks_per_pixel;
  i32[1] = startInt | 0;
  f32[2] = vp.start_ticks - startInt;
  f32[3] = vp.width;
  f32[4] = vp.height;
  f32[5] = vp.row_height;
  f32[6] = vp.dpr;
  i32[7] = vp.selected_row;
  f32[8] = vp.wave_y_offset;
  // f32[9..11] left zero (pad).
}
