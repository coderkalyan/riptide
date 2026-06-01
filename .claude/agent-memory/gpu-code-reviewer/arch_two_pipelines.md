---
name: Single-bit / multi-bit pipeline split
description: Two render pipelines (vs_single/fs_single, vs_multi/fs_multi) share one WGSL module + one bind group layout; differ in fragment fill style (line vs SDF pill) and minor vertex insets.
type: project
---

`createDigitalRenderer` (`src/renderer/gpu/digital.ts`) builds two pipelines from one module + one BGL + one pipeline layout. Each pipeline has its own segment STORAGE buffer (single-bit segments and multi-bit segments are partitioned in Zig: `built.scene.single` and `built.scene.multi`).

Bindings (group 0):
- 0: uniform Viewport
- 1: storage Segments (per-pipeline)
- 2: storage row_colors (shared)
- 3: storage RowInfo (shared)
- 4: storage x0_pool (shared)
- 5: storage x1_pool (shared)

`vs_single`/`vs_multi` share ~80% (corner synth, tick→pixel, center/half-size, clip xform). Differences: multi has asymmetric x-gap inset and packs different flag bits. Could be unified via a pipeline-constant override; deliberate split today is acceptable but flagworthy if a third variant lands.

`fs_single` draws horizontal line + optional left-edge stroke + optional crosshatch. `fs_multi` draws SDF rounded pill (border + fill).

**How to apply:** when adding shader features, consider whether they belong in shared helper fns (`decodeSample`, `hatch`, `sdf`) or in variant-specific fragment paths. Don't duplicate vertex math.
