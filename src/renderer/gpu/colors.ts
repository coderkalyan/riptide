// Per-row color storage buffer — one vec4<f32> (RGBA, 16B) per GPU row,
// indexed in the shader by `segment.rowFlags & 0xffff`. Host writes hex
// strings; we normalize to [0,1] f32.
export const MAX_ROWS = 64;
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
  const packed = new Float32Array(new ArrayBuffer(MAX_ROWS * ROW_COLOR_STRIDE));
  for (const { row, color } of entries) {
    if (row < 0 || row >= MAX_ROWS) throw new Error(`row ${row} out of range (max ${MAX_ROWS})`);
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
