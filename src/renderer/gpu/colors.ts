// Per-row color storage buffer — one vec4<f32> (RGBA, 16B) per GPU row,
// indexed in the shader by `segment.rowFlags & 0xffff`. Host writes hex
// strings; we normalize to [0,1] f32.
// Max active rows. Bounded by the 16-bit row index in the GPU segment's row_flags
// (≤ 65535); must match native segments.zig MAX_ROWS. The color buffer below is one
// vec4 per row = MAX_ROWS×16 B ≈ 1 MB, allocated once (negligible GPU memory); only
// the used prefix is uploaded per write (see writeRowColors).
export const MAX_ROWS = 65535;
export const ROW_COLOR_STRIDE = 16;

export function createColorBuffer(device: GPUDevice): GPUBuffer {
  return device.createBuffer({
    size: MAX_ROWS * ROW_COLOR_STRIDE,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
  });
}

export function writeRowColors(
  device: GPUDevice,
  buf: GPUBuffer,
  entries: { row: number; color: string }[],
): void {
  // Upload only the used prefix [0 .. maxRow]. The GPU buffer is sized for MAX_ROWS,
  // but allocating that full array each call (a ~1 MB Float32Array at the 65535 cap)
  // on every cosmetic change is needless GC. Rows past the prefix keep stale-but-
  // unreferenced colors (no segment's row index points at them).
  let maxRow = -1;
  for (const { row } of entries) {
    if (row < 0 || row >= MAX_ROWS) throw new Error(`row ${row} out of range (max ${MAX_ROWS})`);
    if (row > maxRow) maxRow = row;
  }
  if (maxRow < 0) return;
  const packed = new Float32Array((maxRow + 1) * 4);
  for (const { row, color } of entries) {
    const [r, g, b, a] = hexToRgba(color);
    const off = row * 4;
    packed[off + 0] = r;
    packed[off + 1] = g;
    packed[off + 2] = b;
    packed[off + 3] = a;
  }
  device.queue.writeBuffer(buf, 0, packed);
}

function hexToRgba(hex: string): [number, number, number, number] {
  const h = hex.replace("#", "");
  return [
    parseInt(h.slice(0, 2), 16) / 255,
    parseInt(h.slice(2, 4), 16) / 255,
    parseInt(h.slice(4, 6), 16) / 255,
    1,
  ];
}
