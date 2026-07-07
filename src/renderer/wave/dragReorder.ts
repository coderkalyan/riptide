// Drag-to-reorder transient state for the active-signal rows. Like viewport.ts,
// this lives outside the Zustand store: a drag is purely visual (CSS transforms)
// until release, so writing to the store mid-drag (which would repack/recompute
// memos/autosave) is avoided. The committed reorder is a single store call
// (`reorderSignal`) in the pointerup handler.
//
// Phase 1 animates only the DOM. Phase 2 will read the same per-row offsets from
// the canvas frame loop so the waveforms lift/flow in lockstep — see
// docs/drag-reorder.md.

import { createSignal } from "solid-js";

// One row's static geometry, snapshotted (before any transform) at drag start.
// `top`/`height` are in the scroll container's content coordinate space (CSS px).
export interface DragGeom {
  id: number;      // Row.id (stable across reorders)
  top: number;     // content-space top edge
  height: number;  // row height (excludes attached dividers)
}

export interface DragState {
  dragId: number;                 // Row.id being dragged (the lifted row)
  liftY: number;                  // translateY (px) for the lifted row — tracks the pointer
  offsets: Map<number, number>;   // Row.id -> translateY (px) for the flowing rows
  to: number;                     // current insertion slot among the other rows (0..n-1)
}

const [dragState, setDragState] = createSignal<DragState | null>(null);
export { dragState };

// Module scratch held only for the duration of one drag.
let snap: { geom: DragGeom[]; dragIndex: number; dragHeight: number } | null = null;
// Set true after a real drag commits so the trailing click doesn't also select.
let suppressClick = false;

export function isDragging(): boolean {
  return snap != null;
}

// Begin a drag of the row with `dragId`. `geom` is every row's static geometry in
// list order (index = current row index). No-op if the id isn't found.
export function beginDrag(dragId: number, geom: DragGeom[]): void {
  const dragIndex = geom.findIndex((g) => g.id === dragId);
  if (dragIndex < 0) return;
  snap = { geom, dragIndex, dragHeight: geom[dragIndex].height };
  setDragState({ dragId, liftY: 0, offsets: new Map(), to: dragIndex });
}

// Update the drag from the pointer's content-space Y. Recomputes the target slot
// and the per-row flow offsets that open a gap of one row-height at the target.
export function moveDrag(py: number): void {
  const s = snap;
  if (!s) return;
  const { geom, dragIndex, dragHeight } = s;
  // Target slot = how many of the *other* rows have their center above the pointer.
  let to = 0;
  for (let i = 0; i < geom.length; i++) {
    if (i === dragIndex) continue;
    if (geom[i].top + geom[i].height / 2 < py) to++;
  }
  // A non-dragged row shifts to fill the vacated slot / open the target gap:
  //  - above the origin (i < dragIndex) and now at/below the target → down a row,
  //  - below the origin (i > dragIndex) and now above the target  → up a row.
  const offsets = new Map<number, number>();
  for (let i = 0; i < geom.length; i++) {
    if (i === dragIndex) continue;
    let off = 0;
    if (i < dragIndex) { if (i >= to) off = dragHeight; }
    else { if (i - 1 < to) off = -dragHeight; }
    if (off) offsets.set(geom[i].id, off);
  }
  const liftY = py - (geom[dragIndex].top + dragHeight / 2);
  setDragState({ dragId: geom[dragIndex].id, liftY, offsets, to });
}

// End a drag. Returns {from, to} for the store commit, or null if nothing to do.
// Arms click suppression so the pointerup's trailing click doesn't select.
export function endDrag(): { from: number; to: number } | null {
  const st = dragState();
  const s = snap;
  snap = null;
  setDragState(null);
  if (!st || !s) return null;
  suppressClick = true;
  return { from: s.dragIndex, to: st.to };
}

// Cancel a drag (Esc): clear state, no store change, no click suppression.
export function cancelDrag(): void {
  snap = null;
  setDragState(null);
}

// True once if a drag just committed — lets the row's onClick skip selecting.
export function consumeDragClick(): boolean {
  if (suppressClick) { suppressClick = false; return true; }
  return false;
}
