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
`trace.rs` `std::fs::read` reads the entire VCD into
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

## Name search (scales with hierarchy size)

### No incremental narrowing: every keystroke re-scans every path
`search.rs` has no incremental narrowing: every keystroke scans every node's path
again (filtered by the per-node character mask) and `Flat::prune` rebuilds the
row list. Measured on a 211k-node synthetic trace (release addon, one core,
including the prune, the buffer copies and the napi promise round trip): **0.1 ms
for a miss, 5 ms for a typical query, 11 ms worst case**. It runs as a napi
`AsyncTask` on a libuv worker, so this is latency on the filtered tree, never a
dropped frame. Two levers, both deliberately not pulled: (1) incremental
narrowing, since a query only ever grows while typing, so keystroke *n* need only
re-scan keystroke *n-1*'s survivors; (2) rayon across the mask scan. Trigger to
revisit: a hierarchy past ~500k nodes, or a measured keystroke-to-tree latency
above ~30 ms.

### The filtered row list is materialized as objects on the render thread
`SignalTree`'s `flat` memo turns the native row buffers into one `FlatNode` object
per row. A one-character query against that same 211k-node trace keeps ~144k rows
and costs **~19 ms** of object churn per keystroke on the JS thread — the one part
of filtering that is *not* off-thread. Same cost class as Expand All, which walks
the whole tree into the same shape, so it is not a new failure mode; a real query
keeps hundreds of rows and costs nothing. Fix when it bites: have the memo expose
the typed arrays directly and index them from `windowNodes` instead of
materializing rows the virtualizer will never show.

### Active-signal find marshals every row path per keystroke
`ActiveSignals` calls the sync `markStrings` with all row paths (`rowPaths` is
memoized on the paths themselves, so row edits like color/selection don't re-run
it). Bounded by the active-row count, so it is microseconds for the realistic
hundreds — but it is O(rows) string marshalling on the JS thread, and the row cap
is 65535. Trigger: the same "hundreds+ rows" threshold as the items below; the fix
is the same virtualization, feeding only the visible rows' paths.

## Time range (the GPU tick pipeline is 32-bit)

### A visible window wider than 2^31 ticks draws nothing
`PackedSegment` carries the low 32 bits of tide's `u64` tick, and `digital.wgsl`
positions each endpoint as an `i32` delta from `viewport.start_ticks`. The wrapped
low word is correct for any *delta* that fits `i32`, so what the pipeline can draw
is bounded by the width of the packed window, not by where the trace sits in time.
Two consequences, both handled in `pack.rs`:

- A segment wider than the window — one value held across a long run: a config
  register, a tie-off, a reset that never returns — is **clipped into the window**
  by `renderable_span`. Free, because the renderer over-fetches a screen either
  side and repacks before the viewport reaches an edge, and where it does not
  over-fetch (tick 0, the trace end) the clip lands on a bound the data already
  respects. Only overflowing spans are clipped, so normal packing is untouched.
- A *window* wider than `MAX_SEGMENT_SPAN` cannot position anything inside it, and
  the viewport uniform's `i32 start_ticks` cannot describe one either, so
  `pack_signal` packs the row **empty**. On a trace of more than ~2.1e9 ticks that
  is the zoom-to-fit view: rows read their value in the value column but draw no
  waveform until the visible span comes under the limit. Nothing is lost that used
  to work — every segment at that zoom already positioned at a wrapped, usually
  negative x — but it is a visible hole on long traces.

Until this widens, riptide draws traces up to ~2.1e9 ticks at any zoom and longer
ones only zoomed in. Trigger to revisit: the first trace whose *fit* view is the
one people need, i.e. any run past ~2 s at ns resolution. The fix is a 64-bit tick
pipeline: carry ticks as two u32 lanes (or rebase both the pack and
`start_ticks` on the window) so a delta is computed in 64-bit and truncated after.

## Per-frame GPU (scales with on-screen transition density)

### No decimation / draw budget
Windowing bounds buffers to the visible span, but within one screen there is no
transition cap: a window containing a dense burst packs + draws every transition as
its own instance, so GPU overdraw / vertex throughput grows with on-screen
transition *density* (a sub-pixel segment still costs a full instance). Not yet
measurable — there is no `visible_transitions` / `drawn_primitive_count` hook
(coverage gap — no such hook exists). Trigger: a zoomed-out view of a fast signal
(≫ ~50k transitions on screen) shows GPU pass ms climbing. Fix direction: collapse
sub-pixel runs during pack, or a per-row draw budget.

Legibility runs out before throughput does. `digital.wgsl` caps the multi pill's
2 px value gap at a third of the segment, so a pill keeps two thirds of its pitch
however far out you zoom instead of being inset out of existence — but once the
pitch itself is a pixel or two, what a row shows is a rasterization phase pattern,
not data. Collapsing sub-pixel runs during pack is what actually answers that, and
it is the same work as the draw budget above.

## Many active rows — Y-axis windowing (the row cap is now 65535)

The active-row cap was raised 64 → 65535 (`gpu/colors.ts` + `segments.rs` Scene
rows made dynamic). Correctness scales, but per-row work does not — the three items
below all violate the "scales with what's on screen" principle on the **Y** axis,
the same way the time window already solves it on the X axis. Trigger: a view with
more rows than fit on screen (hundreds+).

### Active-signal DOM list isn't virtualized
`ActiveSignals.tsx` `<For each={s.activeSignals}>` mounts a DOM row (+ its per-row
value `createMemo` on `cursorTicks`, resize handle, eye/pin) for **every** active
signal, not just the visible ones. Hundreds+ rows → heavy DOM + reactive churn on
every cursor move / edit. Fix: virtualize with `@tanstack/solid-virtual`
(`SignalTree` already does), sharing one vertical scroll offset with the canvas.

### No vertical scroll for the waveform pane
Canvas height == window; rows stack top-down by `RowInfo.y_offset` with nowhere to
overflow, so rows past the fold are off-screen and unreachable. Fix: a vertical
scrollbar + scroll offset driving both the canvas Y (the viewport already carries
`wave_y_offset`, today only the ruler) and the DOM list `scrollTop` in lockstep.

### Pack + per-frame cost is O(total rows), not O(visible rows)
`getMockSegments(buildPackSpecs())` packs **every** active row each repack, and the
rAF loop walks all rows for layout / value cells — the time axis bounds this to the
visible window, the Y axis has no equivalent. Fix: vertical culling — pack + draw
only rows in the visible Y band (± a margin), mirroring the X-axis viewport
windowing. Until then CPU encode ms + repack cost grow with the active-row count,
not with what's on screen.

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
