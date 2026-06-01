---
name: Per-frame allocation hotspot in App.tsx rAF
description: rAF body in App.tsx allocates fresh arrays/closures every frame for rectsBg, linesBg, flagRects, addFlag — GC pressure target
type: project
---

Recurring smell: `App.tsx`'s `frame()` rAF body allocates per call:
- `rectsBg.setRects([{...}, {...}, ...rulerTicks.map(...), {...}])` — fresh array + spread
- `linesBg.setLines(CLOCK_EDGE_TICKS.filter(...).map(...))`
- `linesFg.setLines([{...}, {...}])`
- `flagRects: [...] = []` and inline `addFlag` closure
- spread/map/filter in hot loops

**Why:** the rect/line/text batch APIs take whole arrays each frame, which encourages this pattern. Sub-millisecond per frame today (small N), but problematic when VCD scale lands or zoomed-out renders include thousands of grid ticks.

**How to apply:** when reviewing/refactoring, prefer reusable scratch buffers and direct push APIs (`batch.clear(); batch.pushRect(...)`) over array-rebuilds. Hoist closures out of rAF. Don't flag minor cases; flag when N grows or new per-frame allocations appear.
