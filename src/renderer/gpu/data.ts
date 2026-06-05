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

// Viewport = 12 × 4 B = 48 bytes (multiple of 16, required by WebGPU). Mixed
// int/float fields per the WGSL Viewport struct: slot 1 (start_ticks_int) and
// slot 7 (selected_row) are i32; the rest are f32. Slots 9..11 are pad to hit
// 16-byte alignment (row dimming now lives in RowInfo.flags, not a viewport
// bitmask). Caller provides aliased Float32 and Int32 views over the same
// ArrayBuffer so each slot is written with the correct bit pattern without
// per-frame allocation.
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
  // Slots 9..11 are pad: never written, stay zero-initialized.
}
