---
name: Full repack on add-signal + per-render value queries
description: add-signal repacks ALL active signals from scratch in Zig; cursor drag re-renders whole active list with per-row getValueAt napi calls.
metadata:
  type: project
---

Two secondary large-case costs beyond [[perf_no_viewport_culling]]:

**1. add-signal repacks everything.** `App.tsx rebuildSceneRef` → `getMockSegments(packSpecsFor(active))` re-queries tide + re-packs ALL active signals (not just the new one), destroys+recreates every GPU storage buffer (segment bufs, rowInfo, x0/x1 pools), and rebuilds all pill labels. O(total segments) per add. Buffer destroy+create mid-session can stall. For N adds of a big trace this is O(N × total). Incremental append (only pack the new row, append to pools, grow buffers) would make it O(new row).

**2. Per-render value column.** `App.tsx:2170` — the active-signal list `.map` calls `formatSegmentValue(valueAtTick(sig.handle, cursorTicks), ...)` for EVERY row on every render. `valueAtTick` → `getValueAt` is a napi→Zig→tide point query (crosses the JS/native boundary, allocates a JS object + word arrays each call). Cursor drag calls `setCursorTicks` per pointermove → re-renders the whole (uncompiled) App → N napi queries per drag frame. App is deliberately NOT React-compiled (imperative WebGPU loop bails the compiler), so nothing memoizes this. Hover readout was already split into an external store (hoverStore) for exactly this reason — but the cursor value column was not. Scales O(rows) per cursor move; with many rows + napi overhead this is real jank.

**Note:** the rAF frame loop ITSELF is well-optimized — pooled scratch arrays (getRect/getLine), hoisted vp object, fixed pill pool, no per-frame allocs. The old "per-frame allocation hotspot" memory is now OUTDATED (that refactor landed). The remaining CPU costs are in React render paths (value column) and the native repack, not the rAF body.
