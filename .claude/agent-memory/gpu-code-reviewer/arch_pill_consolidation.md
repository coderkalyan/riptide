---
name: arch-pill-consolidation
description: All pills (markers+cursor) share ONE rect buffer + ONE text buffer; per-pill firstInstance draws preserve painter-order occlusion. Replaced per-pill rect+text pairs.
metadata:
  type: project
---

The `perf/pill-buffer-consolidation` branch's headline change (frame.ts + WaveCanvas.tsx).

**Before:** `PillLayer { rects, text }[]` — one RectBatch + one TextBatch buffer per pill (markers + cursor). N pills = 2N buffers + 2N writeBuffers/frame.

**After:** `pillRects: RectBatch` + `pillText: TextBatch` (ONE buffer each), `pillRanges: PillRange[]` ({rectStart,rectCount,textStart,textCount}), `pillRangeCount`. Frame loop fills both shared buffers in ONE setRects/setGlyphs each (pillRectScratch accumulator), then frame.ts draws per-pill via `pass.draw(4, count, 0, firstInstance)`. Per-pill *draws* (not buffers) keep the painter's-order occlusion — each pill's rect draws before/under the next pill's rect, covering earlier pills' text. No z-buffer.

**Correctness verified:** direct (non-indirect) draws with non-zero firstInstance are always allowed in WebGPU core (only INDIRECT-first-instance needs a feature). `@builtin(instance_index)` starts from firstInstance, so `rects[ii]`/`glyphs[ii]` reads the right slice. Shared buffers sized MAX_RECTS=1024 / MAX_GLYPHS=4096; pills ≤ MAX_MARKERS+1 = 17 → well within bounds.

Pill order: `ordered = selId==null ? markers : markers sorted so selected is LAST` (drawn on top), then cursor pill added last (topmost). addFlag appends rect+glyphs and records the PillRange.

Other branch perf work (digital.wgsl): caret SDF + crosshatch hatch (both with fwidth) now guarded behind `if (caret)` / `if (enable_crosshatch)` — flat per-instance flags are warp-coherent so fwidth stays in uniform control flow; skips ALU on non-edge/non-hatch segments. text.ts: AtlasBuild now supports an rgba bytes path + atlasFactory override for the headless canvas-test harness (Deno, no Canvas 2D).
