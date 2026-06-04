# Testing

There is no unit-test or linter setup. Verification is manual (`pnpm dev`) plus
the deterministic GPU harness below.

## Canvas (GPU) testing

Goal: prove that GPU refactors meant to be **visual no-ops** (buffer
consolidation, draw-call reshaping, packing tweaks) produce **pixel-identical**
output. The harness renders the real `src/renderer/gpu/*` modules headlessly to
an offscreen texture and compares the read-back pixels against a checked-in
golden, byte-for-byte.

### Runtime

- **Deno** runs the render (it has native WebGPU; Node 26 does not). On this box
  it uses the AMD GPU via Vulkan/RADV.
- **esbuild** (run under Node) bundles the harness + the gpu modules, resolving
  the `.wgsl` text imports, into `scripts/canvas-test/harness.bundle.mjs` (git-ignored).
- Text/label atlases use `OffscreenCanvas` in the app; Deno has no Canvas 2D, so
  `text.ts` exposes an `atlasFactory` seam (`TextOptions.atlasFactory`). Default
  (app) behavior is unchanged — the harness injects a deterministic procedural
  atlas uploaded via `writeTexture`.

### Commands

```
pnpm canvas-test          # render the production path, compare to golden, exit 1 on diff
pnpm canvas-test:update   # (re)generate the golden: scripts/canvas-test/golden/scene.{bin,png}
pnpm canvas-test:equiv    # self-contained no-op proof (see below)
```

- `scene.bin` (raw RGBA, the comparison source of truth) and `scene.png` (human
  view) are committed. On a `CHECK FAIL` the actual frame is written to
  `/tmp/canvas-check-actual.png` for eyeballing.
- Determinism holds for before/after runs on the same machine/driver — that is
  what no-op proofs need. Cross-machine pixel identity is not guaranteed (and not
  required); regenerate the golden if you change machines.

### Workflow

1. **Visual change** (intended): make it, run `pnpm canvas-test:update`, commit
   the new golden alongside the code. The PNG diff in review shows the change.
2. **No-op change** (optimization/refactor): make it, run `pnpm canvas-test`. It
   must `CHECK PASS` against the unchanged golden. If it fails, the change wasn't
   a no-op.

### The scene

`harness.ts` builds one representative frame (768×128, dpr 1, window 0..96 ns):
two single-bit clock rows + one multi-bit bus row (digital single/multi
pipelines), dashed grid + cursor/marker lines, a panel tint + crosshatch
dead-zone (rect pipeline), ruler text (text pipeline), and three flag pills
(cursor + 2 markers). Waveform samples, viewport, and pill positions are
hard-coded fixtures — edit `harness.ts` to extend coverage, then re-`update`.
Value labels (`labels.ts`) are wired but left empty; extend if that path changes.

### `--equiv`: proving a no-op without a baseline checkout

When a refactor changes *how* something is drawn but not the result, `--equiv`
renders both ways within the current build and asserts pixel identity — no git
worktree or API juggling needed. The pill-buffer consolidation
(`pillRects`/`pillText` shared buffer + per-pill `firstInstance` draws, vs the
old one-rect-batch-and-one-text-batch-per-pill) is checked this way: the harness
renders via the production `renderFrame` and via a local per-pill-batch reference
encoder, then diffs. Use the same pattern for future "merge the buffers / reshape
the draws" changes.
