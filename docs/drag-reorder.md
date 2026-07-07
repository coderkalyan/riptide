# Drag-to-reorder active signals

Design for grabbing an active-signal row and dragging it to a new position: the
row lifts and follows the pointer while the other rows flow around it to open a
gap where it will drop. Two phases — Phase 1 lands a polished DOM interaction
with the canvas reordering only on release; Phase 2 makes the canvas waveforms
lift and flow in lockstep with the names.

## What the code already gives us

- **`Row = ActiveSignalRef & { id }`** (`store/store.ts`) — a stable per-row
  `id` (`rowSeq`). The `<For each={s.activeSignals}>` in `ActiveSignals.tsx` is
  keyed by object reference, so reordering the array (same objects, new order)
  makes Solid *move* the existing DOM nodes rather than remount them.
- **Per-row state rides the object** — `selected`, `height`, `dividers`, color,
  radix all live on the Row. A reorder carries them for free. Only the
  index-keyed transients need remapping: `ctxMenu.row`, `picker.row`, and the
  module-level `selectionAnchor`.
- **`renumber()`** already rewrites the positional `row` field after a
  structural change, so the commit is just splice + `renumber`.
- **Canvas reorder is cheap.** The pack cache keys on handle+kind+radix+enums,
  **not** the row index, so a reorder is all cache hits — `rebuildScene`
  reassembles the scene in the new order and `setRowLayout` recomputes the
  cumulative y. No tide query, no repack.
- **Canvas y is per-frame from store order.** `setRowLayout(heightOf, top,
  gapBelowOf)` (`gpu/digital.ts`) walks rows in order summing
  height + dividers. This is the hook Phase 2 bends to animate the canvas.
- **Dividers belong to their owner row** (`row.dividers`), rendered as siblings
  after the row inside the same `<For>` iteration. They travel with the row, so
  a dragged row-block carries its dividers automatically.

## Interaction model

- Press a row body, then move past a small threshold (~5 px) to start the drag.
  A plain click that never crosses the threshold still selects the row. The
  bottom resize handle and the pin/eye controls already `stopPropagation`, so
  they keep working.
- On start the row **lifts** (raised z-index, shadow, slight scale) and follows
  the pointer's Y. The remaining rows **flow** to open a gap exactly the dragged
  row's height at the insertion slot.
- Release drops the row into the gap. `Esc` cancels and snaps it back.
- Affordance: whole-row grab (matches "click to grab the signal"); cursor
  `grab` → `grabbing`, plus a faint `⋮⋮` grip that fades in on hover at the left
  edge for discoverability.

**No store writes happen mid-drag.** The array stays fixed; the reorder is
purely visual (CSS transforms) until release. This avoids canvas thrash, value
memo recompute, and sidecar autosave churn during the drag.

## Drag state — transient module, not Zustand

`wave/dragReorder.ts`, mirroring the `viewport.ts` pattern: module-level
transient state plus one Solid signal for DOM reactivity. Holds:

```
dragId        // Row.id being dragged
startY, pointerId
rowGeom[]     // {id, top, height, center} snapshot at drag start (getBoundingClientRect)
targetIndex   // computed insertion slot
liftY         // dragged row's follow offset
offsetForRow(id) -> px   // how far each non-dragged row shifts
```

Drop-index math: snapshot each row's rect at drag start (this already accounts
for divider gaps). `targetIndex` = the count of rows whose center sits above the
pointer Y. Rows between origin and target shift by ±draggedHeight. Standard
reflow.

## Phase 1 — polished DOM, canvas reorders on release

**DOM (full interaction):**

- `pointerdown` on `.s-row` body records the start but does not start the drag.
  `pointermove` past the threshold starts it and calls `setPointerCapture`.
- The dragged element gets `transform: translateY(liftY)` + raised z + shadow —
  the real element, not a clone, so its reactivity is preserved.
- Other rows get `transform: translateY(±draggedHeight)` with
  `transition: transform 150ms ease` → the flowing gap.
- Autoscroll the `.signals` container when the pointer nears its top/bottom edge.
- `pointerup` commits one store action `reorderSignal(fromRow, toIndex)`
  (splice + `renumber`, remap `selectionAnchor`, clear `ctxMenu`). Clear the
  transient transforms in the same frame — the DOM is now truly ordered and the
  transforms were already near-final, so there is no visible jump. The dragged
  element settles into its slot with a short transition.
- `Esc` clears the transient with no store write.

**Canvas:** untouched during the drag. On release the store set fires the
`activeSignals` subscription → the existing `rebuildScene` + `applyRowLayout`
(cache hits, no repack) → the canvas snaps to the new order on the next frame.

**Known Phase-1 limitation (accepted):** during the drag the DOM names flow but
the canvas waveforms stay put, so the name column and the waveforms are
vertically out of sync until release. Phase 2 removes exactly this gap.

## Phase 2 — canvas animates with the DOM

Goal: the waveforms lift and flow in lockstep with the names.

`setRowLayout` already computes per-row y each frame from order + heights. Bend
it with the *same* offsets the DOM uses:

- Extend `dragReorder.ts` with animated per-row offsets: each frame **lerp** the
  current offset toward its target (CSS uses transitions; the canvas must
  replicate the easing manually, so lerp ~0.2/frame). One geometry source feeds
  both the DOM handler and the canvas, so they agree by construction.
- WaveCanvas frame loop: while a drag is active, call `applyRowLayout` every
  frame with `y += dragReorder.offsetForRow(row)`, and render the dragged row's
  waveform lifted by `liftY` (optionally a shadow band behind it).
- Only the y offsets change — **no PackKey change → no repack**, just the
  `setRowLayout` `writeBuffer` (already the per-frame fast path). Cheap.
- Release: clear the transient; `setRowLayout` returns to the true store order.
  Optional final settle-lerp.

## Edge cases / risks

- **Transient-vs-store double offset at commit** — clear the transforms in the
  same tick as the store set; the DOM is already visually placed, so the seam is
  a no-op.
- **Variable heights + dividers** — snapshot rects at drag start; dividers fold
  into the row's block height. Top-dividers (above row 0) are pinned, not
  draggable.
- **Autoscroll** in the scrollable `.signals` container.
- **Index-keyed transients** — remap `selectionAnchor`, clear `ctxMenu`/`picker`
  on commit. `selected`/`height`/`dividers` ride the objects, so they are free.
- **Threshold tuning** so click-select and the bottom resize handle stay intact.

## Deferred

- **Multi-select drag** — dragging a whole selected block. The store already has
  `moveSignals`; a `reorderSignals(rows, toIndex)` would mirror it. Out of scope
  for now; single-row drag only.

## New code surface

| File | Add |
|---|---|
| `wave/dragReorder.ts` | new transient controller (geom snapshot, offsets, lerp) |
| `store/store.ts` | `reorderSignal(from, to)`; `selectionAnchor` remap |
| `ActiveSignals.tsx` / `ActiveSignal.tsx` | pointerdown/move/up handlers, grip affordance, drag CSS classes |
| `index.css` | `.s-row.dragging` (lift/shadow), `transition: transform` on rows, grab cursors |
| `WaveCanvas.tsx` (Phase 2) | per-frame offset layout + lifted-row render |
