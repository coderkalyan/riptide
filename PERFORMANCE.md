# Performance notes

Running log of performance-relevant design decisions, the optimizations that are
in place, and the ones deliberately deferred (with the reason + the trigger to
revisit). Pair with the perf overlay (backtick `` ` `` / `?perf=1`): it splits
**CPU encode ms** vs **GPU pass ms**, which tells you whether a given large-case
slowdown is CPU-bound (per-frame JS) or GPU-bound (overdraw / vertex throughput).

---

## Viewport-related culling

Principle: per-frame work should scale with **what's on screen**, not with the
size of the trace. A frame that pans/zooms over a 10M-transition trace should cost
the same as one over a 100-transition trace at the same zoom. Anything that walks
the whole dataset every frame violates this and shows up as CPU encode ms growing
with trace length.

### Digital segment draw (planned, owned separately)

`frame.ts` currently issues `pass.draw(4, segmentCount)` with the **full** packed
count per pipeline — every segment of every signal, every frame, regardless of
zoom. The intended fix is a per-row binary search over the (sorted, contiguous)
segment list to find the visible `[firstInstance, lastInstance)` window and draw
only that range (`pass.draw(4, visibleCount, 0, firstInstance)`). This index is
the shared primitive the items below should also consume.

### Clock grid lines (loop 1.2) — DONE: closed-form + decimated CPU emit

Was: a per-frame scan over a `CLOCK_EDGE_TICKS` array holding *every* rising edge
in the trace, filtering to the visible window — O(total clock edges) / frame.

Now: generated closed-form from **phase** (`gridEdge0 = MOCK_CLOCK_TICK_NS`) +
**period** (`CLOCK_PERIOD_NS`), and **decimated** with the same `rulerSpacing`
1/2/5× decade snap the ruler uses, so lines never pack tighter than ~8 across the
view. Edge `k` sits at `gridEdge0 + k·(cycleStep·period)`; the CPU loop emits only
`k` in the visible window. Because decimation caps line density, the emitted count
is bounded by `viewportWidth / minSpacing` (~hundreds) **regardless of trace
length**. The lines are instanced already (`lines.ts`). `cycleStep` mirrors
`clockRulerTicks`, so in clock-anchor mode the grid aligns with the ruler notches.

**Phase/period source (current vs future):** today `gridEdge0`/`CLOCK_PERIOD_NS`
are mock constants (the same ones the ruler uses). The real-trace path is to detect
them from the designated clock row — loop its transitions only until the first two
rising edges are found (phase = first, period = second − first), then stop; this
assumes a uniform clock (gated/variable clocks would mis-grid — accepted).

**Future optimization — fully GPU-side line generation.** The CPU still emits one
instance per visible line. Since the positions are a pure arithmetic sequence, this
can move entirely to the GPU: the CPU sets `phase`, `period`, `cycleStep`, `firstK`
and `count` as uniforms, draws `count` instances, and the line vertex shader
computes each instance's tick as `phase + (firstK + instance_index)·cycleStep·
period` → x. Zero per-line CPU work; needs a periodic-grid shader variant/pipeline.
Deferred because the decimated count is already bounded (~hundreds), so the CPU
emit is not a measured bottleneck — revisit if line emit ever shows up in CPU
encode ms.

### Multi-bit value labels (loop 1.1) — pure-GPU instanced culling

Was: a per-frame scan over `multiLabels` (one entry per multi-bit segment — the
label *text* is precomputed at repack, but the loop still positioned every label
via `xForTick`, applied the narrow-pill LOD skip, and emitted glyphs) — O(total
multi-bit segments) / frame, and it did **not** cull off-screen labels (wide pills
off to the side still emitted glyphs the rasterizer then clipped).

Now: the label glyph instances are built **once** (at repack) into a static
instance buffer, and the **vertex shader** positions each glyph from tick-space +
the viewport uniform and **self-culls** — a guard at the top of the VS collapses
the quad to degenerate when its pill is too narrow to fit the text (the old width
check) or fully off-screen. Per-frame CPU cost for labels drops to zero; the GPU
does the positioning and culling. Row dimming reuses `RowInfo.flags` bit 0
(`ROW_FLAG_DIM`), the same flag the waveform shader reads.

**Known non-optimality — no binary search.** This is pure GPU culling by design
(to stress the GPU path), so the vertex shader runs for **every** label glyph
instance every frame — O(total label glyphs) vertex invocations — even though most
degenerate immediately. It is **not** binary-searched to the visible range. Two
costs grow with trace size: (1) the resident glyph instance buffer (≈ Σ label
lengths × instance stride — tens of MB on a huge trace), and (2) the wasted vertex
invocations for off-screen glyphs.

**Hard ceiling — `maxStorageBufferBindingSize` (confirmed in the field).** The
resident instance buffer is a *storage buffer*, so it can never exceed
`maxStorageBufferBindingSize`. A wide + long trace blows past it: a 64-bit value
renders as ~16 glyphs, so `demo_wide_n64_500kcyc.vcd` (1.1 GB, 500k cycles) yields
millions of labels → hundreds of MB of glyph instances, over the **default 128 MiB**
binding limit → the bind group was rejected as invalid and every frame failed to
submit. Mitigations now in place:
- `device.ts` requests the **adapter's actual** `maxStorageBufferBindingSize` /
  `maxBufferSize` instead of the conservative defaults (128 MiB / 256 MiB), so big
  traces that fit the hardware limit just work.
- `labels.ts` **caps** the glyph count at `maxStorageBufferBindingSize / stride`
  and `console.warn`s the dropped count (no silent truncation). The cap drops by
  buffer order (whole later rows lose labels) when it bites — a stopgap, not a real
  answer for production.

The cap exposes the deeper point: **pure-resident doesn't scale past the GPU's
binding limit**, full stop. Windowing (below) is the actual fix — it bounds the
buffer to O(visible) so the ceiling is never approached. (Related: `buildMultiLabels`
issues one `getValueAt` napi call *per* multi-bit segment at repack — 500k+ calls on
this trace, a slow load independent of the buffer crash; windowing fixes that too by
only formatting visible labels.)

### Multi-bit value labels (loop 1.3) — incremental per-signal cache — DONE

Was: every repack (add/remove/reorder/recolor/radix from the active set) re-ran
`buildMultiLabels` over **all** active rows — one `getValueAt` per multi-bit segment
of **every** signal, not just the one that changed. So adding the Nth signal paid the
full-trace `getValueAt` storm for the N−1 signals already present — the "rebuild value
labels" perf mark grew with the active-signal count, not with the added signal.

Now: `buildMultiLabels` (`App.tsx`) caches formatted labels per `signalId` in a
module-level `labelCache`, keyed `signalId → { radix, labels }`. A label's text depends
only on `(signalId, radix)`: the `getValueAt(handle, tStart)` query is deterministic per
signal+trace and the segment set (incl. mute flags) is deterministic per signal+gate —
the **row index only affects placement, not text**. Each repack groups the native
segments by row (cheap, no napi), then per active signal: **cache hit** (same
`signalId`+`radix`) reuses the cached label text, reassigning only `row` (covers
reorder) — zero `getValueAt`; **miss** (new signal or radix change) queries+formats just
that signal's segments and caches them. The cache is pruned to the active set each
repack (bounds memory to ≈ the resident label set) and cleared on trace swap
(`resetForTrace`, since a new trace re-parses handles/values). So the `getValueAt` storm
now scales with the **changed** signal, not the whole active set.

This does **not** fix the resident-buffer ceiling or the off-screen-glyph VS cost above
— `setLabels` still rebuilds the full glyph instance buffer each repack (pure JS
expansion + one `writeBuffer`, far cheaper than the napi storm). Windowing (below)
remains the fix for those and would subsume this cache.

*Future optimization (now the real fix, not just an optimization):* binary-search
the visible label range — labels are row-grouped and sorted by `tStart`, and the
multi-pipeline `RowInfo.segment_start` gives each row's sub-range, so the **same
visible-window index built for the segment draw cull** can pick `[firstInstance,
instanceCount)` per row and build/draw only on-screen labels. That turns the VS work
from O(total glyphs) into O(visible glyphs), bounds the buffer regardless of trace
size, and avoids the per-segment `getValueAt` storm.

---

## Deferred deficiencies (non-critical)

Recorded for tracking. **None are critical** and none scale with trace size onto
the hot path — the viewport-culling items above dominate large-case cost. Not
under active discussion; listed so they aren't lost.

### Tier 3 — draw-call / writeBuffer overhead (bounded)

Per-frame draw calls ≈ `6 + 2×(active pills)` ≈ ~40 worst case (16 markers +
cursor); per-frame `writeBuffer`s ≈ ~39. **Bounded by `MAX_MARKERS = 16`**, so it
does not grow with trace size. webgpufundamentals' optimization wins (mapped
buffers, fewer draws) target 8k–18k objects; we're at ~40, so this is not a
bottleneck at any realistic scale. Do not invest here until the perf overlay shows
`queue.writeBuffer`/submit dominating CPU-encode ms.

- **3.1 Per-pill draw+writeBuffer storm** — `frame.ts` loops `allPills` (17 = 16
  marker pills + cursor); each `PillLayer` is its own rect+text batch → its own
  `writeBuffer`×2 + draw×2 per frame (count-0 pills skip). Consolidatable to one
  rect + one text batch, *but* the per-pill split exists for painter's-order
  occlusion (each pill's rect must cover earlier pills' text); batching breaks that
  on overlap (would need a depth/z or accepting label z-fight on rare marker
  overlap). Not worth it at 16.
- **3.2 Pill batch buffers oversized** — each pill's rect batch is `MAX_RECTS=1024`
  (24 KB) and text batch `MAX_GLYPHS=4096` (64 KB), but a pill uses 1 rect +
  ~10–30 glyphs. 17 pills ≈ ~1.5 MB GPU memory mostly unused. Memory smell, not a
  perf issue; give pill batches a small cap if this code is touched.
- **3.3 writeBuffer → mapped-buffer ring** (webgpufundamentals §1/§6) — ~40 % JS
  reduction *in their 18k-object benchmark*; here the per-frame writeBuffers are
  few and small, so this only matters if CPU-encode ms is ever dominated by
  `queue.writeBuffer`.

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

Real per-frame allocations in the rAF body, each bounded by visible-tick / marker
count (small) — so low GC pressure, but the "allocation-free rAF" claim is
approximate:

- `rulerArrowLabels = []` rebuilt each frame.
- `dynamicRulerTicks` / `clockRulerTicks` return fresh `{ ticks, labels }` arrays
  each frame.
- `[...markers].sort(...)` allocates when a marker is selected.

Reuse pooled scratch arrays here only if the perf overlay shows GC spikes.
