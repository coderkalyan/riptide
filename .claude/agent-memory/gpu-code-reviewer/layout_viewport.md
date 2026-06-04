---
name: layout-viewport
description: 48-byte (12×4B) uniform. start_ticks split int/frac. Slots 1 & 7 are i32, slot 9 is now PAD (dim moved to RowInfo.flags). DPR retained but UNUSED by shaders.
metadata:
  type: project
---

Viewport uniform = **48 bytes (12 × 4B)**, 16-aligned. Written via aliased Float32Array + Int32Array over one ArrayBuffer in `writeViewportInto` (`gpu/data.ts`), no per-frame alloc. Slots:

0. ticks_per_pixel: f32
1. start_ticks_int: **i32** (split from start_ticks)
2. start_ticks_frac: f32
3. width: f32 (CSS px)
4. height: f32 (CSS px)
5. row_height: f32 (CSS px)
6. dpr: f32  (RETAINED but UNUSED by shaders — see DPR contract)
7. selected_row: **i32**
8. wave_y_offset: f32
9. _pad0: f32  (CHANGED: was dim_mask u32; row dimming moved to RowInfo.flags bit 0 to scale past 32 rows)
10. _pad1: f32
11. _pad2: f32

start_ticks split int/frac is intentional: shader does `f32(i32(t_start) - start_ticks_int) - start_ticks_frac` to keep full integer precision for tick values > 2^24. Same split in digital.wgsl (vs_main dt) AND labels.wgsl (vs_label start_px/end_px).

**DPR contract (do NOT flag):** all viewport dims + vertex coords are CSS px. Shaders divide by CSS width/height; framebuffer is clientSize×dpr so clip→framebuffer already scales DPR. Shader size literals (line thickness 2.0/2.5, radius 4.0, hatch 8.0, border 2.0, caret arm 8.0/5.0) are bare CSS px and must NOT be multiplied by dpr. DPR applied in exactly ONE place: `resizeCanvas` (device.ts). The `vp.dpr` field is written every frame (WaveCanvas) but no shader reads it — confirmed dead-but-intentional.

**FIVE copies of the Viewport struct exist** — `digital.wgsl`, `labels.wgsl`, `lines.wgsl`, `rect.wgsl`, `text.wgsl` (all name slots 9–11 `_pad0/1/2`) + writeViewportInto in data.ts. Any field change = update all 5 WGSL copies + writeViewportInto. Total must stay multiple of 16B. All 5 WGSL copies currently identical and correct.
