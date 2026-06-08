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

## Load / memory (scales with trace size — revisit on the first big real trace)

### Whole-VCD slurp + full in-RAM db (no size cap, no streaming)
`mock_db.zig` `readFileAllocOptions(…, .unlimited, …)` reads the entire VCD into
RAM, then tide builds a full in-memory db on top — no size ceiling, no
backpressure. A multi-GB VCD OOMs at load (surfaces as a thrown JS error, so it
doesn't corrupt, but it can't open). Trigger to revisit: first multi-hundred-MB /
GB trace; longer-term wants a size cap or the streaming model tide references.

### Every Open VCD leaks the prior trace
`tide`'s `Database.deinit` frees only the signal list + map, never the per-signal
`timestamps`/`x0s`/`x1s` payloads (`Signal.deinit` exists but is never called), so
each in-app trace swap leaks the entire prior trace (~0.42 MB/swap on the mock; the
whole trace on a real one → RSS grows monotonically, OOM after enough opens). A
*bug*, not a deferred optimization, but it's the dominant memory cost of repeated
opens. Fix is upstream: loop `for (db.signals.items) |*s| s.deinit(db.gpa);` in
`tide`'s `Database.deinit`.

## Per-frame GPU (scales with on-screen transition density)

### No decimation / draw budget
Windowing bounds buffers to the visible span, but within one screen there is no
transition cap: a window containing a dense burst packs + draws every transition as
its own instance, so GPU overdraw / vertex throughput grows with on-screen
transition *density* (a sub-pixel segment still costs a full instance). Not yet
measurable — there is no `visible_transitions` / `drawn_primitive_count` hook
(tests/FINDINGS.md coverage gap). Trigger: a zoomed-out view of a fast signal
(≫ ~50k transitions on screen) shows GPU pass ms climbing. Fix direction: collapse
sub-pixel runs during pack, or a per-row draw budget.

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
