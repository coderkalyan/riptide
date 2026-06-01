---
name: Viewport uniform layout
description: 8×4B = 32-byte uniform; slot 6 is i32 (selected_row), all others f32. Written via aliased Float32/Int32 views.
type: project
---

Viewport uniform = 32 bytes (16-aligned per WebGPU). Slots:
0. ticks_per_pixel: f32
1. start_ticks: f32
2. width: f32 (CSS px)
3. height: f32 (CSS px)
4. row_height: f32 (CSS px)
5. dpr: f32
6. selected_row: **i32** (the only int slot)
7. wave_y_offset: f32

CSS-pixel + DPR contract: dimensions stay in CSS px, dpr is passed separately, shaders multiply (e.g. `1.0 * viewport.dpr` for line thickness, `gap_px = 2.0 * dpr`). The canvas backing store sized via `resizeCanvas(canvas)` accounts for DPR, and clip-space division by CSS `width`/`height` yields correct NDC because aspect/scale is preserved.

**How to apply:** `writeViewportInto(f32, i32, vp)` in `data.ts` writes via aliased views — preserve this pattern, no per-frame allocation. Any new uniform field must keep total size a multiple of 16B.
