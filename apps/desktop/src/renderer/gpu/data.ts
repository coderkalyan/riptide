export interface Segment {
  tStart: number;  // nanoseconds (integer)
  tEnd: number;
  value: number;   // 0 or 1 for digital
  row: number;     // 0-based row index
  flags: number;   // packed flags u32 (reserved, set to 0)
}

// Viewport describing the visible time window and canvas dimensions.
// Passed to the GPU as a uniform buffer each frame.
export interface Viewport {
  t0: number;           // ns — left edge
  t1: number;           // ns — right edge
  width: number;        // canvas pixels (physical, post-DPR)
  height: number;
  rowHeight: number;    // pixels per signal row  (physical)
  rowPadding: number;   // vertical inset inside each row (physical)
  offsetY: number;      // y of row 0 from canvas top (physical)
  linePx: number;       // signal line thickness in physical pixels
}

// ---- hardcoded signals ------------------------------------------------

// rst_n: deasserted after 5 ns, glitch at 55 ns
function makeRst(row: number): Segment[] {
  return [
    { tStart: 0, tEnd: 5, value: 0, row },
    { tStart: 5, tEnd: 55, value: 1, row },
    { tStart: 55, tEnd: 58, value: 0, row },
    { tStart: 58, tEnd: 100, value: 1, row },
  ];
}

// irq: sporadic interrupt pulses
function makeIrq(row: number): Segment[] {
  return [
    { tStart: 0, tEnd: 18, value: 0, row },
    { tStart: 18, tEnd: 23, value: 1, row },
    { tStart: 23, tEnd: 47, value: 0, row },
    { tStart: 47, tEnd: 52, value: 1, row },
    { tStart: 52, tEnd: 71, value: 0, row },
    { tStart: 71, tEnd: 75, value: 1, row },
    { tStart: 75, tEnd: 100, value: 0, row },
  ];
}

// data_valid: high window with mid dip
function makeDataValid(row: number): Segment[] {
  return [
    { tStart: 0, tEnd: 12, value: 0, row },
    { tStart: 12, tEnd: 38, value: 1, row },
    { tStart: 38, tEnd: 42, value: 0, row },
    { tStart: 42, tEnd: 78, value: 1, row },
    { tStart: 78, tEnd: 100, value: 0, row },
  ];
}

// busy: long high then alternating short pulses
function makeBusy(row: number): Segment[] {
  return [
    { tStart: 0, tEnd: 8, value: 0, row },
    { tStart: 8, tEnd: 63, value: 1, row },
    { tStart: 63, tEnd: 70, value: 0, row },
    { tStart: 70, tEnd: 77, value: 1, row },
    { tStart: 77, tEnd: 84, value: 0, row },
    { tStart: 84, tEnd: 91, value: 1, row },
    { tStart: 91, tEnd: 100, value: 0, row },
  ];
}

// done: single short pulse near end
function makeDone(row: number): Segment[] {
  return [
    { tStart: 0, tEnd: 82, value: 0, row },
    { tStart: 82, tEnd: 88, value: 1, row },
    { tStart: 88, tEnd: 100, value: 0, row },
  ];
}

export const HARDCODED_SEGMENTS: Segment[] = [
  ...makeRst(0),
  ...makeIrq(1),
  ...makeDataValid(2),
  ...makeBusy(3),
  ...makeDone(4),
];

// Only the time range is static — geometry fields are filled in per-frame
// from DOM measurements in App.tsx.
export const DEFAULT_VIEWPORT: Viewport = {
  t0: 0, t1: 100,
  width: 800, height: 400,
  rowHeight: 28,
  rowPadding: 4,
  offsetY: 0,
  linePx: 2.5,
};

// ---- GPU packing -------------------------------------------------------
// Layout: each segment = 4 × f32 = 16 bytes
//   [0] tStart  [1] tEnd  [2] value  [3] row  [4] flags   (all u32)
// Matches the storage buffer struct in the WGSL shader.

export function packSegments(segs: Segment[]): Uint32Array {
  const buf = new Uint32Array(segs.length * 5);
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i];
    buf[i * 5 + 0] = s.tStart;
    buf[i * 5 + 1] = s.tEnd;
    buf[i * 5 + 2] = s.value;
    buf[i * 5 + 3] = s.row;
    buf[i * 5 + 4] = s.flags;
  }
  return buf;
}

// Viewport packed as 8 × f32 = 32 bytes (multiple of 16, required by WebGPU).
export function packViewport(vp: Viewport): Float32Array {
  return new Float32Array([
    vp.t0, vp.t1,
    vp.width, vp.height,
    vp.rowHeight, vp.rowPadding,
    vp.offsetY, vp.linePx,
  ]);
}
