---
name: rAF frame body is now allocation-free (resolved)
description: The old per-frame array/closure allocation smell in App.tsx frame() was fixed — pooled scratch + hoisted vp. Don't re-flag.
metadata:
  type: project
---

RESOLVED (confirmed 2026-06-02). `App.tsx`'s `frame()` rAF body no longer allocates per frame. It now uses:
- pooled `rectsBgScratch` / `linesBgScratch` / `linesFgScratch` / `pillRectScratch` reused arrays with `getRect(arr,i)` / `getLine(arr,i)` accessors that grow-but-never-shrink and reset flag fields in place
- a hoisted `vp` viewport object mutated in place
- batch `setRects(scratch, count)` / `setLines(scratch, count)` / `setGlyphs(count)` APIs that take an explicit count so a pooled array longer than the live region works
- a fixed pool of MAX_MARKERS pill batches (`markerPills`) + `allPills` built once

Remaining minor per-frame allocs are trivial: `rulerArrowLabels` array (small), `dynamicRulerTicks`/`clockRulerTicks` returning fresh `{ticks,labels}` arrays, and `[...markers].sort(...)` for marker draw order (only when a marker is selected). These are bounded by visible ruler ticks / marker count (≤16), NOT by segment count — leave them unless a profile says otherwise.

**Do NOT re-flag the rAF body for allocations.** The real remaining CPU costs are [[perf_no_viewport_culling]] (GPU draw count) and [[perf_repack_and_value_queries]] (React value column + native repack). Focus reviews there.
