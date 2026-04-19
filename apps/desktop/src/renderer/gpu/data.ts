export interface Segment {
  tStart: number;  // nanoseconds
  tEnd: number;
  value: number;   // 0 or 1 for digital; bus value as integer
  row: number;     // 0-based row index
}

// Viewport describing the visible time window and canvas dimensions.
// Passed to the GPU as a uniform buffer each frame.
export interface Viewport {
  t0: number;           // ns — left edge
  t1: number;           // ns — right edge
  width: number;        // canvas pixels (physical, post-DPR)
  height: number;
  rowHeight: number;    // pixels per signal row
  rowPadding: number;   // vertical gap inside each row
}

// ---- hardcoded signals ------------------------------------------------

// clk: period 10 ns, 0–100 ns → 20 segments
function makeClock(row: number, period = 10, end = 100): Segment[] {
  const segs: Segment[] = [];
  for (let t = 0; t < end; t += period / 2) {
    segs.push({ tStart: t, tEnd: t + period / 2, value: (t / (period / 2)) % 2, row });
  }
  return segs;
}

// rst_n: high after 5 ns
function makeRst(row: number): Segment[] {
  return [
    { tStart: 0,  tEnd: 5,   value: 0, row },
    { tStart: 5,  tEnd: 100, value: 1, row },
  ];
}

// c[10:0]: a bus — repurpose value as 0/1 high-impedance visual for now
// (full bus rendering comes later; treat as a digital for this task)
function makeBus(row: number): Segment[] {
  return [
    { tStart: 0,  tEnd: 20,  value: 0, row },
    { tStart: 20, tEnd: 45,  value: 1, row },
    { tStart: 45, tEnd: 70,  value: 0, row },
    { tStart: 70, tEnd: 100, value: 1, row },
  ];
}

// data_valid: derived signal
function makeDataValid(row: number): Segment[] {
  return [
    { tStart: 0,  tEnd: 30,  value: 0, row },
    { tStart: 30, tEnd: 60,  value: 1, row },
    { tStart: 60, tEnd: 100, value: 0, row },
  ];
}

export const HARDCODED_SEGMENTS: Segment[] = [
  ...makeClock(0),
  ...makeRst(1),
  ...makeBus(2),
  ...makeDataValid(3),
];

export const DEFAULT_VIEWPORT: Viewport = {
  t0: 0, t1: 100,
  width: 800, height: 400,
  rowHeight: 24,
  rowPadding: 4,
};

// ---- GPU packing -------------------------------------------------------
// Layout: each segment = 4 × f32 = 16 bytes
//   [0] tStart  [1] tEnd  [2] value (f32)  [3] row (f32)
// Matches the storage buffer struct in the WGSL shader.

export function packSegments(segs: Segment[]): Float32Array {
  const buf = new Float32Array(segs.length * 4);
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i];
    buf[i * 4 + 0] = s.tStart;
    buf[i * 4 + 1] = s.tEnd;
    buf[i * 4 + 2] = s.value;
    buf[i * 4 + 3] = s.row;
  }
  return buf;
}

// Viewport packed as 6 × f32 = 24 bytes → round up to 32 (WebGPU uniform
// buffers must be multiples of 16 bytes; two padding floats at the end).
export function packViewport(vp: Viewport): Float32Array {
  return new Float32Array([
    vp.t0, vp.t1,
    vp.width, vp.height,
    vp.rowHeight, vp.rowPadding,
    0, 0,  // padding
  ]);
}
