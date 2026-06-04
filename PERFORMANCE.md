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

## Deferred deficiencies (non-critical)

Recorded for tracking. **None are critical** and none scale with trace size onto the
hot path. Not under active discussion; listed so they aren't lost.

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
