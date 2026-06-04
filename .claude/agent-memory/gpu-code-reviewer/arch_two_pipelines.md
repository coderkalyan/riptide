---
name: arch-two-pipelines
description: single/multi digital pipelines share ONE WGSL module + ONE BGL + ONE pipeline layout; now unified into vs_main with a VARIANT override constant (0 single, 1 multi). fs_single / fs_multi distinct.
metadata:
  type: project
---

`createDigitalRenderer` (`src/renderer/gpu/digital.ts`) builds two pipelines from one module + one BGL + one pipeline layout. Each pipeline has its own segment STORAGE buffer (single-bit vs multi-bit segments partitioned in Zig: `scene.single` / `scene.multi`).

**Vertex shader is now UNIFIED** — single `vs_main` (not separate vs_single/vs_multi). `override VARIANT: u32` (VARIANT_SINGLE=0, VARIANT_MULTI=1) folds at pipeline-compile time. The only two real differences: `xgap_px = select(0.0, 2.0, VARIANT==MULTI)` (right-edge inset, multi only) and `F_DRAW_LINE_HIGH` packed only when VARIANT==SINGLE. Set via `constants: { VARIANT: variantConst }` on BOTH vertex+fragment stages in buildPipelineFromPacked.

Bindings (group 0): 0 uniform Viewport, 1 storage Segments (per-pipeline), 2 storage row_colors (shared, vec4<f32> MAX_ROWS=64), 3 storage RowInfo (shared), 4 storage x0_pool (shared), 5 storage x1_pool (shared). All storage = VERTEX visibility, read-only.

`fs_single`: horizontal line (lo/hi) + optional left vertical edge + optional rising-edge caret (now `if(caret)`-guarded) + optional crosshatch (`if(enable_crosshatch)`-guarded). `fs_multi`: SDF rounded pill (corner_sdf, border+fill) + optional crosshatch.

`buildPipelineFromPacked` = async compile + own segment buffer. `rebindPipeline` = reuse compiled pipeline with a fresh segment buffer + rebound bind group (synchronous — add/remove repacks on the spot). `createSceneBuffers` builds shared rowInfo/x0/x1 + keeps rowInfoCpu for setDimFlags patching.

Both fragments composite against bg `vec3f(0.106,0.114,0.129)` (= CLEAR_VALUE) and output opaque; F_DIM blends 50% toward bg in RGB (not alpha) so grid never shows through. Caret_sdf has a dead `rotation = radians(0.0)` block (identity mat2x2 — compiler folds it; leftover from the rect.wgsl version which DOES take a rotation arg).
