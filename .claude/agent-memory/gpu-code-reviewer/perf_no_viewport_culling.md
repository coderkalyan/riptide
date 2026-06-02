---
name: No viewport culling — draws all segments every frame
description: The dominant large-case perf bottleneck. instanceCount = total segment count, not visible. No binary search anywhere.
metadata:
  type: project
---

**Highest-leverage large-case perf issue.** `frame.ts:72` does `pass.draw(4, pipeline.segmentCount)` where segmentCount = the FULL packed segment count for that pipeline (set in digital.ts bindSegments). There is **zero viewport culling** anywhere in the renderer (verified: grep for binary/bisect/cull/upperBound/firstVisible finds nothing in the draw path). Every segment of every active signal is rasterized every frame regardless of zoom — when zoomed out, thousands of sub-pixel pills/lines each spawn a 4-vertex strip + run the full fragment shader (SDF, hatch fwidth, decodeSample word-fold loop). Cost scales with TOTAL segments × overdraw, not visible width.

**Why it's not biting yet:** mock.vcd is tiny (end_t ~90, ~tens of segments). Will explode the moment a real large VCD loads (signals × transitions can be 10^5–10^7).

**Fix direction (in order of leverage):**
1. CPU-side per-row binary search over the sorted segment array for [startTick, endTick]; draw only `[firstVisible, lastVisible)` via `pass.draw(4, count, 0, firstInstance)` (firstInstance base-instance). tide queries are already sorted by timestamp so the data supports bisection.
2. Coalesce sub-pixel segments at pack time per zoom (LOD) — when many transitions fall in one pixel column, emit one crosshatch "busy" segment. Needs repack on zoom, so secondary.
3. Move packing/culling fully native (Zig) and only ship the visible window to the GPU.

Per-row contiguity (segment_start) + sorted timestamps make (1) straightforward. This is THE thing to recommend first for large traces.
