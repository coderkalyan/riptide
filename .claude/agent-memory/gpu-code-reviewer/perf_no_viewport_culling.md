---
name: perf-viewport-windowing
description: Viewport-windowed packing now EXISTS (was the old "no culling" issue). Frame loop repacks the visible window + 1-screen over-fetch margin via hysteresis. Pan/zoom-in within margin = uniform-only.
metadata:
  type: project
---

**RESOLVED / SUPERSEDED.** The old "draws ALL segments, no culling" issue is fixed. As of `perf/pill-buffer-consolidation` there is viewport-windowed packing.

**How it works** (WaveCanvas.tsx frame loop, ~lines 231-270 + main.zig getMockSegments(specs, qStart, qEnd)):
- `getMockSegments` now takes a tick window `[qStart, qEnd]`. Native `db.query(handle, q_start, q_end)` is a binary-search slice (tide queries sorted by timestamp) — returns only in-window samples + the sample active at qStart (so left-edge pill draws from offscreen, identical to full pack). Cost is O(window), not O(total).
- Renderer over-fetches: `M = visibleTicks` (one screen each side); guard band `G = M*0.5`. `needRepack` when: specsDirty (active-set change) OR packedRange null OR view enters guard band at either packed edge (gated on room beyond trace bounds 0/TRACE_END so edge doesn't retrigger) OR `tpp > pr.tpp*ZOOM_OUT_FACTOR` (1.5) OR `pr.end-pr.start > visibleTicks*WINDOW_SHRINK_FACTOR` (6).
- Pan + zoom-IN within the margin = pure viewport-uniform updates (shader transforms already-packed segments) → cheap at any zoom. Only re-windowing triggers a repack.
- Right-edge correctness: half-open query means last in-window segment's t_end snaps to end_t; the margin keeps it offscreen so its t_end/caret/single-bit-edge are never seen.

**No per-signal pack cache anymore** — getMockSegments comment says cache was dropped because packed output is now viewport-dependent (a config-keyed cache would never hit across pans). So every repack re-queries tide + reformats labels for ALL active signals over the window. Add-signal still repacks all (not incremental) but only over the window, not full trace.

**Remaining large-trace cost:** every re-window repacks all active signals (tide query + flag compute + native label format) and destroys+recreates all GPU storage buffers (segment bufs, rowInfo, x0/x1 pools) — see rebuildScene in WaveCanvas. Mid-drag re-windowing (zoom) can stall on buffer destroy+create. Label append fast-path exists (setLabels reusePrefix) but only for pure-append adds, not re-windows.
