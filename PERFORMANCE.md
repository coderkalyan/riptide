# Performance notes

TODO list of **remaining** performance problems and deliberately-deferred
optimizations (each with the reason deferred + the trigger to revisit). Implemented
optimizations are intentionally **not** recorded here. Pair with the perf overlay
(backtick `` ` `` / `?perf=1`): it splits **CPU encode ms** vs **GPU pass ms**, which
tells you whether a given large-case slowdown is CPU-bound (per-frame JS) or
GPU-bound (overdraw / vertex throughput).

Principle: per-frame work should scale with **what's on screen**, not the size of the
trace. A frame that pans/zooms over a 10M-transition trace should cost the same as
one over a 100-transition trace at the same zoom. Anything that walks the whole
dataset every frame violates this and shows up as CPU encode ms growing with trace
length.

Context: packing is viewport-windowed (TIDE_INTEGRATION.md §2.10), so the resident
segment + value + glyph buffers are already bounded to **O(visible window ± one
screen of over-fetch margin)**. The items below are what remains on top of that.

---

## In-frame draw culling (trim the over-fetch margin)

The packed buffers are O(visible ± margin); these would trim the ±1-screen margin in
the draw itself. Both should share one per-row visible-range index.

### Digital segment draw cull

`frame.ts` issues `pass.draw(4, segmentCount)` with the **full packed count** per
pipeline every frame — now bounded to the visible window ± margin, but still drawing
the margin. A per-row binary search over the (sorted, contiguous) segment list finds
the visible `[firstInstance, lastInstance)` and draws only that range (`pass.draw(4,
visibleCount, 0, firstInstance)`). This index is the shared primitive the label cull
below should also consume. **Lower priority** now that the resident count is
O(visible); revisit if a larger over-fetch margin is wanted, or if margin draw shows
up in GPU pass ms.

### Multi-bit label margin cull

The label glyph vertex shader runs for **every instance in the packed window** and
self-culls (collapses the quad to degenerate when its pill is off-screen or too
narrow for the text). With windowing the instance buffer is O(visible), but the VS
still runs over the ±1-screen margin glyphs. Binary-search the visible label range —
labels are row-grouped and sorted by `tStart`, and the multi-pipeline
`RowInfo.segment_start` gives each row's sub-range, so the **same index as the
segment-draw cull** picks `[firstInstance, instanceCount)` per row and skips the
margin glyphs. Do it **alongside** the segment cull, not on its own — small win
post-windowing. (`labels.ts` still caps the glyph count at
`maxStorageBufferBindingSize / stride` with a `console.warn` — a backstop that
windowing keeps from ever biting; leave it.)

---

## Deferred deficiencies (non-critical)

Recorded for tracking. **None are critical** and none scale with trace size onto the
hot path. Not under active discussion; listed so they aren't lost.

### Tier 4 — shader ALU (only bites when fragment-bound)

- **4.1 Unconditional SDF / hatch** — `fs_single` computes `caret_sdf` + `hatch`
  for *every* fragment and then `select`s the result, even on segments with no
  caret/crosshatch; `fs_multi` always computes `hatch`. Wasted ALU on every
  covered pixel. The deciding flags are `@interpolate(flat)` (per-instance), so a
  real `if` guard branches warp-coherently with no divergence. The win scales with
  covered pixels (big pills / zoomed in) — secondary to the culling work.
- **4.2 `decodeSample` OR-fold** — fine (1 iteration for ≤32-bit rows, 2 for
  64-bit). No action.
- **Overdraw** — low: per-row segments are non-overlapping and rows don't overlap.
  No action.

### Tier 5 — per-frame allocations (minor GC)

The array/object churn here is now pooled: span-arrow/RESET labels
(`rulerArrowScratch` + `getArrowLabel`), the ruler tick/label arrays
(`rulerTicksScratch`/`rulerLabelsScratch`, callers read the returned count not
`.length`), and the marker draw-order list (`orderedScratch`, copied + sorted in
place instead of `[...markers].sort`).

Residual: the ruler **label strings** are still freshly allocated each frame
(`toFixed` / `` `#${c}` `` / `"… ns"` templates) — bounded by visible-tick count
(~10–30), so low GC pressure. Interning them would need a per-(tick,spacing)
cache keyed on the formatted value; not worth it unless the perf overlay shows GC
spikes from string churn.
