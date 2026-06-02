---
name: Viewport uniform layout
description: 48-byte (12×4B) uniform. start_ticks split int/frac. Slots 1 & 7 are i32, slot 9 is u32 (dim_mask). DPR retained but UNUSED by shaders.
metadata:
  type: project
---

Viewport uniform = **48 bytes (12 × 4B)**, 16-aligned per WebGPU. (Was 32B/8 slots in an older revision — corrected 2026-06-02.) Written via aliased Float32Array + Int32Array over one ArrayBuffer in `writeViewportInto` (`gpu/data.ts`), no per-frame alloc. Slots:

0. ticks_per_pixel: f32
1. start_ticks_int: **i32**  (split from start_ticks)
2. start_ticks_frac: f32
3. width: f32 (CSS px)
4. height: f32 (CSS px)
5. row_height: f32 (CSS px)
6. dpr: f32  (RETAINED but UNUSED by shaders — see DPR contract)
7. selected_row: **i32**
8. wave_y_offset: f32
9. dim_mask: **u32** (per-row 50%-opacity bitmask; row i → bit i; only rows < 32)
10. _pad1: f32
11. _pad2: f32

start_ticks split int/frac is intentional: shader does `f32(i32(t_start) - start_ticks_int) - start_ticks_frac` to keep full integer precision for tick values > 2^24.

**DPR contract (do NOT flag):** all viewport dims + vertex coords are CSS px. Shaders divide by CSS width/height; framebuffer is clientSize×dpr so clip→framebuffer already scales DPR. Shader size literals (line thickness 2.0/2.5, radius 4.0, hatch 8.0, border 2.0) are bare CSS px and must NOT be multiplied by dpr. DPR applied in exactly one place: `resizeCanvas` (device.ts). dim_mask only covers rows 0..31 (`r.row < 32` guard in App.tsx) — rows ≥ 32 silently can't be dimmed.

**How to apply:** THREE copies of the Viewport struct exist — `digital.wgsl`, `lines.wgsl` (its copy still names slot 9 `_pad0`, semantically fine since it doesn't read dim_mask), and writeViewportInto. rect.wgsl/text.wgsl also bind the same uniform. Any field change = update all WGSL copies + writeViewportInto. Total must stay multiple of 16B.
