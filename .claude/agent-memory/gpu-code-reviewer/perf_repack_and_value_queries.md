---
name: perf-value-queries
description: Per-row cursor value column = N napi getValueAt per cursor-move frame. Now SolidJS createMemo-per-row (keyed on cursorTicks), not React. Repack-all now windowed (see perf-viewport-windowing).
metadata:
  type: project
---

App is now **SolidJS** (was React in older memory). The imperative WebGPU loop (WaveCanvas) never subscribes reactively — pulls store state each frame via useAppStore.getState(). Components are fine-grained reactive.

**Per-render value column (still a cost).** `ActiveSignals.tsx:~60` — each active row's value cell is a `createMemo(() => formatSegmentValue(valueAtTick(sig.handle, s.cursorTicks), ...))` inside a `<For>`. `s.cursorTicks` is reactive, so a cursor drag (setCursor per pointermove) recomputes ALL N row memos → N napi `getValueAt` calls/frame, each crossing JS/native + allocating JS word arrays (jsWordArray). Scales O(visible rows) per cursor move. HoverReadout.tsx does one more on hover. Not a regression on the pill branch; a standing cost. Fix: window/throttle, or push cursor value compute native + batch.

**Repack-all is now windowed** — see [[perf-viewport-windowing]]. add-signal still repacks all active signals but only over the visible window (not full trace), and destroys+recreates all GPU storage buffers. Label append fast-path (setLabels reusePrefix) covers pure-append adds.

**rAF frame body is alloc-free** — pooled scratch (getRect/getLine reuse RectMut/LineMut objects), hoisted `vp` object, fixed pill accumulators, viewport written via aliased typed arrays. writeRowColors only on init + active-set change (NOT per frame). Don't re-flag per-frame allocs in the rAF body.
