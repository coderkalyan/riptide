---
name: bug-label-append-stale-on-swap
description: LabelBatch append fast-path (isAppend) can spuriously trigger on a trace SWAP, reusing stale glyph-buffer prefix bytes from the previous trace. Narrow but real.
metadata:
  type: project
---

**OPEN (low-prob) correctness bug as of 2026-06 review.** WaveCanvas `rebuildScene` computes `isAppend` by comparing `lastLabelActive` (the active list the label buffer currently reflects) against the new `active` by `signalId:row:radix:role`. When true, `LabelBatch.setLabels(reusePrefix=true)` keeps the GPU glyph-buffer prefix `[0, builtSegs)` and uploads only appended segments.

On a trace SWAP (`unsubTrace` → `rebuildScene(rows, 0, TRACE_END)`), `lastLabelActive` still holds the OLD trace's list, and NodeIds restart per-trace (native `n.id` from 0), so the prefix can match by the compared keys. If the new trace has strictly MORE signals than the old with a matching prefix, `isAppend=true` → old trace's pill-label glyphs persist for the matching rows; only new rows upload. Wrong text for the matched rows.

Requires `active.length > prev.length` (strictly greater) AND prefix key-match — reopening the same view (equal length) is safe. The swap path reuses the SAME `rebuildScene` as add-from-tree with no "force full rebuild" override.

**Fix:** on swap, force a full label rebuild — pass `isAppend=false` (e.g. add a `forceFullLabels` param to rebuildScene, set on the swap call), or reset `lastLabelActive=[]` before the swap's rebuildScene. Cheap; labels are rebuilt every repack anyway except this fast path.
