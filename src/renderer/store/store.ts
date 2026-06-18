// The single app store. Built on a vanilla zustand store (wrapped in
// subscribeWithSelector) and exposed to Solid via solid-zustand/store, which
// mirrors zustand state into a fine-grained Solid store: a setState updates only
// the DOM that reads the changed fields, never a whole re-render.
//
// Two ways to read it:
//   - components: `const s = useAppStore()` (reactive proxy) — fine-grained.
//   - rAF loop / native handlers: `useAppStore.getState()` / `.setState()` —
//     synchronous, no reactivity, no stale-closure problem (this is why the
//     React state+ref+sync-effect triples collapse here).
//
// The persisted (document) slice is shaped to map 1:1 onto the existing sidecar
// (see selectSidecar). Transient render-loop state (viewport zoom/pan, drag,
// scratch) does NOT live here — it stays as plain `let`s in the canvas layer.

import { createStore as createVanilla } from "zustand/vanilla";
import { subscribeWithSelector } from "zustand/middleware";
import { shallow } from "zustand/shallow";
import { create } from "solid-zustand/store";

import { SCENE, INITIAL, TRACE_END, makeActiveRef, handleForPath, type ActiveSignalRef, type Radix, type ActiveRole, type ClockConfig, type EnumEntry } from "../hier/scene";
import type { NodeId } from "../hier/types";
import type { ClockGrid } from "../wave/format";
import { detectClockGrid } from "../wave/clock";
import { MAX_ROWS } from "../gpu/colors";
import { MAX_MARKERS } from "../wave/constants";
import {
  serializeSidecar,
  sidecarToString,
  writeSidecarFile,
  sidecarPath,
  type SidecarSnapshot,
} from "../hier/sidecar";
import { MARKER_PALETTE } from "../wave/palette";

// ---- types --------------------------------------------------------------

export interface Marker {
  id: number;     // unique, monotonic; also drives the Mn name
  name: string;
  tick: number;
  color: number;  // packed rgba (0xAABBGGRR), matches the sidecar's hexToPacked
}

// A row carries a stable monotonic `id` (named `id` so solid-zustand's internal
// reconcile keys on it — preserving row identity across renumber/remove, so
// <For> reuses DOM). Everything else is the trace/presentation metadata.
export type Row = ActiveSignalRef & { id: number };

export interface PanelState {
  treeWidth: number;
  activeWidth: number;
  treeCollapsed: boolean;
  activeCollapsed: boolean;
  activeCompactWidth: number | null;
}

// Identifies one divider for remove/resize: the row it sits below (by positional
// `row` index) and its slot in that row's `dividers` array. `row === -1` targets
// the top gap (Scene.topDividers).
export type DividerTarget = { row: number; index: number };

export interface DocState {
  activeSignals: Row[];
  // Separator heights (CSS px; 0 = default) above the first row — the top gap.
  // Per-row dividers live on each Row's `dividers`; this is the one gap with no row
  // above it. Empty in the common case.
  topDividers: number[];
  markers: Marker[];
  selectedMarkerId: number | null;
  cursorTicks: number;
  viewRange: { start: number; end: number };
  snapCursor: boolean;
  clockAnchor: boolean;
  // Timebase: which clock-format signal (by path) drives cycle math + the grid,
  // and an optional manual period/phase override. Persisted in the sidecar.
  timebaseClock: string | null;
  timebaseOverride: { period: number; phase: number } | null;
  // Derived (NOT serialized — recomputed on load / selection from the timebase
  // clock): the detected cycle grid. The reset crosshatch is built per frame in
  // the canvas from the active reset rows' visible high spans, not stored here.
  clockGrid: ClockGrid | null;
  expandedScopes: NodeId[]; // array (not Set) so reconcile/serialization stay simple
  panels: PanelState;
}

export interface UiState {
  hover: { tick: number; row: number } | null;
  // `row` anchors the swatch/Coloris; `rows` (optional) is the full set the chosen
  // color is applied to (a selection from the context menu). Defaults to [row].
  picker: { row: number; rows?: number[]; anchorRect: DOMRect } | null;
  // `kind` distinguishes a signal-row menu from a divider menu from a tree menu.
  // The tree menu carries `nodeId` (the right-clicked hierarchy node) and uses
  // row -1 (it acts on the tree selection, not an active row).
  ctxMenu: { x: number; y: number; row: number; kind?: "signal" | "divider" | "tree" | "pane"; nodeId?: NodeId; div?: DividerTarget } | null;
  enumDialog: { row: number } | null;
  // Bumped on viewport-settle (pan end / wheel / zoom-anim end) so the autosave
  // persists the final window — viewRange itself is excluded from the save
  // trigger (the rAF loop writes it per frame during interaction).
  viewSaveNonce: number;
  // Bumped by resetForTrace (in-app Open VCD…). The canvas subscribes to it to
  // reset the viewport + re-instrument perf; the repack/colors flow through the
  // normal activeSignals subscriptions since the active set changes too.
  traceNonce: number;
  // Set by the file watcher when the on-disk trace changes — we do NOT auto-reload
  // (that would clobber the view mid-inspection); instead the titlebar pill lights
  // up warm so the user can click reload. Cleared on (re)load via freshUi.
  traceStale: boolean;
  // Signal-tree multi-select: hierarchy node ids (scopes + signals) the user has
  // selected for a batch add. Ephemeral UI — NOT persisted to the sidecar; cleared
  // on trace swap via freshUi.
  treeSelection: NodeId[];
}

export interface Actions {
  addSignal: (signalId: NodeId) => void;
  // Append every signal id (non-signals skipped) in one set — "add all in scope".
  addSignals: (signalIds: NodeId[]) => void;
  removeSignal: (row: number) => void;
  // Multi-row variants for context-menu actions over a selection. Atomic so the
  // row renumber (see renumber) happens once, not per-row (looping by index would
  // break as earlier removals/moves reindex the rest).
  removeSignals: (rows: number[]) => void;
  moveSignal: (row: number, to: "top" | "bottom") => void;
  moveSignals: (rows: number[], to: "top" | "bottom") => void;
  setColor: (row: number, color: string) => void;
  setRadix: (row: number, radix: Radix) => void;
  setRole: (row: number, role: ActiveRole | undefined) => void;
  // Apply a Format choice atomically: radix + role together (data formats clear
  // any clock/reset role). One set → one repack, no transient inconsistent state.
  setFormat: (row: number, radix: Radix, role: ActiveRole | undefined) => void;
  setClockConfig: (row: number, clock: ClockConfig) => void;
  setEnumTable: (row: number, enumTable: EnumEntry[]) => void;
  // Set (or clear, with undefined) the mute signal — a 1-bit enable, by path —
  // that mutes these rows wherever it isn't logic-1. Triggers a repack (native
  // splits segments on its edges); persisted in the sidecar per row.
  setMute: (rows: number[], mute: string | undefined) => void;
  // Per-row vertical size (CSS px). undefined resets to the default ROW_HEIGHT_CSS.
  setRowHeight: (row: number, height: number | undefined) => void;
  // Insert a separator. Below `row` appends to that row's gap; above `row` appends
  // to the previous row's gap (or the top gap if `row` is first). Bottom appends
  // below the last row (or the top gap when no rows). Always adds — back-to-back
  // dividers are allowed (no toggle-to-remove).
  addDividerBelow: (row: number) => void;
  addDividerAbove: (row: number) => void;
  addDividerBottom: () => void;
  // Remove one divider by target (row + slot; row -1 = top gap).
  removeDivider: (t: DividerTarget) => void;
  // Resized divider height (CSS px). undefined resets to DIVIDER_HEIGHT_CSS (0).
  setDividerHeight: (t: DividerTarget, height: number | undefined) => void;
  toggleHidden: (row: number) => void;
  // Hide every active row except `row` (which is forced visible).
  hideOthers: (row: number) => void;
  // Hide every active row except those in `rows` (the kept/selected set).
  hideExcept: (rows: number[]) => void;
  // Global toggle: if any row is dimmed, show all; otherwise dim all.
  toggleAllHidden: () => void;
  // Select a row. No modifier → replace (deselect all, select this). ctrl/meta →
  // toggle this row, keep others. shift → range-select from the anchor to this row.
  selectRow: (row: number, opts?: { ctrl?: boolean; shift?: boolean }) => void;
  clearSelection: () => void;

  // Signal-tree selection (mirrors selectRow). No modifier → replace; ctrl/meta →
  // toggle this node; shift → range over `flatIds` (the flat-visible row order) from
  // the anchor to this node. `flatIds` is passed in because only the tree knows the
  // current expanded/visible ordering.
  selectTreeNode: (id: NodeId, opts: { ctrl?: boolean; shift?: boolean }, flatIds: NodeId[]) => void;
  // Replace the tree selection outright (e.g. "Select All in Scope"). Anchors on
  // the last id so a follow-up shift-click ranges from there.
  setTreeSelection: (ids: NodeId[]) => void;
  clearTreeSelection: () => void;

  addMarkerAtCursor: () => void;
  deleteMarker: (id: number) => void;
  selectMarker: (id: number | null) => void;
  moveMarker: (id: number, tick: number) => void;
  setMarkerTick: (id: number, tick: number) => void;
  clearMarkers: () => void;
  cycleMarker: (dir: 1 | -1) => void;

  setCursor: (tick: number) => void;
  setViewRange: (start: number, end: number) => void;
  bumpViewSave: () => void;
  toggleSnap: () => void;
  // Toggle clock-aligned mode on/off (View menu). Turning it on with no timebase
  // clock auto-picks the first role:"clock" row.
  toggleClock: () => void;
  // Set (or clear, with null = absolute time) the timebase clock by path. Drives
  // clock-aligned mode + re-detects the cycle grid.
  setTimebaseClock: (path: string | null) => void;
  // Manually override the detected period/phase of the timebase clock.
  setTimebaseOverride: (period: number, phase: number) => void;

  toggleScope: (id: NodeId) => void;
  setExpanded: (ids: NodeId[]) => void;

  setTreeWidth: (w: number) => void;
  setActiveWidth: (w: number) => void;
  setTreeCollapsed: (v: boolean) => void;
  setActiveCollapsed: (v: boolean) => void;
  setActiveCompactWidth: (w: number | null) => void;

  setHover: (h: { tick: number; row: number } | null) => void;
  setPicker: (p: { row: number; rows?: number[]; anchorRect: DOMRect } | null) => void;
  setCtxMenu: (m: { x: number; y: number; row: number; kind?: "signal" | "divider" | "tree" | "pane"; nodeId?: NodeId; div?: DividerTarget } | null) => void;
  setEnumDialog: (d: { row: number } | null) => void;

  // Re-seed the whole document slice from the freshly-swapped SCENE/INITIAL (the
  // caller runs scene.swapTrace first). One atomic set → subscribers fire once.
  resetForTrace: () => void;
  setTraceStale: (v: boolean) => void;
}

export type AppState = DocState & UiState & Actions;

// ---- monotonic counters (module-scoped latches, never rendered) ---------
let rowSeq = 1;   // unique row id; never reused, so <For>/reconcile identity is stable
let markerSeq = 1; // unique marker id/name; deletes never reuse a name
let selectionAnchor = -1; // last single/ctrl-selected row; shift-range pivots here
let treeAnchor: NodeId | null = null; // last single/ctrl-selected tree node; shift-range pivots here

const withRowId = (r: ActiveSignalRef): Row => ({ ...r, id: rowSeq++ });

// Clamp a tick into the loaded trace's bounds [0, TRACE_END]. TRACE_END is a live
// binding (reassigned by swapTrace), so this reads the current trace end each call.
// Keeps the cursor/markers from being placed in the past-end dead zone via the
// editable time fields. While idle (no trace) TRACE_END is 0 → everything pins to 0.
const clampTick = (t: number): number => Math.max(0, Math.min(TRACE_END, t));

// Detect the cycle grid from the timebase clock (unless overridden). Pure read
// of the clock signal's prefix via native getEdges. null when nothing resolves.
function computeTimebase(
  active: readonly ActiveSignalRef[],
  clockPath: string | null,
  override: { period: number; phase: number } | null,
): ClockGrid | null {
  if (clockPath == null) return null;
  const handle = handleForPath(clockPath);
  if (handle == null) return null;
  // A corrupt override (period <= 0 or non-finite — e.g. a hand-edited / migrated
  // sidecar) would make the ruler + grid cycle loops spin forever (format.ts
  // clockRulerTicks, WaveCanvas clock-grid loop). Reject it and fall through to
  // auto-detection rather than trusting it.
  if (override && override.period > 0 && isFinite(override.period) && isFinite(override.phase)) {
    return { period: override.period, phase: override.phase, valid: true };
  }
  const polarity = active.find((r) => r.path === clockPath)?.clock?.polarity ?? "rising";
  return detectClockGrid(handle, polarity);
}

// ---- hydration ----------------------------------------------------------

function hydrateDoc(): DocState {
  const markers: Marker[] = INITIAL.markers.map((m, i) => ({
    id: i + 1, name: m.name, tick: m.tick, color: m.color,
  }));
  markerSeq = markers.length + 1;
  const selIdx = INITIAL.markers.findIndex((m) => m.selected);

  // Timebase: prefer the saved clock path; else auto-pick the first role:"clock"
  // row so a grid is ready the moment clock-aligned mode is toggled. The on/off
  // (clockAnchor) honours the saved/fresh toggle — we don't force it on.
  const active = SCENE.activeSignals;
  let timebaseClock = INITIAL.timebase.clockPath;
  let clockAnchor = INITIAL.toggles.clockAnchor;
  if (timebaseClock == null) {
    const firstClock = active.find((r) => r.role === "clock");
    if (firstClock) timebaseClock = firstClock.path;
  }
  const timebaseOverride = INITIAL.timebase.override ?? null;
  const clockGrid = computeTimebase(active, timebaseClock, timebaseOverride);
  // A saved/auto clock absent from this trace → fall back to absolute time.
  if (timebaseClock != null && clockGrid == null) { timebaseClock = null; clockAnchor = false; }

  return {
    activeSignals: active.map(withRowId),
    topDividers: [...SCENE.topDividers],
    markers,
    selectedMarkerId: selIdx >= 0 ? selIdx + 1 : null,
    cursorTicks: INITIAL.time.cursor,
    viewRange: { start: INITIAL.time.start, end: INITIAL.time.end },
    snapCursor: INITIAL.toggles.snapCursor,
    clockAnchor,
    timebaseClock,
    timebaseOverride,
    clockGrid,
    expandedScopes: [...SCENE.initialExpanded],
    panels: { ...INITIAL.panels },
  };
}

const freshUi = (): Omit<UiState, "traceNonce"> => ({ hover: null, picker: null, ctxMenu: null, enumDialog: null, viewSaveNonce: 0, traceStale: false, treeSelection: [] });

// Renumber rows so `row` stays the contiguous 0..N-1 canvas/Y slot. Keeps each
// surviving row's `id` (identity) so reconcile/<For> reuse its DOM.
const renumber = (rows: Row[]): Row[] => rows.map((r, i) => (r.row === i ? r : { ...r, row: i }));

// ---- store --------------------------------------------------------------

const vanilla = createVanilla<AppState>()(
  subscribeWithSelector((set) => ({
    ...hydrateDoc(),
    ...freshUi(),
    traceNonce: 0,

    addSignal: (signalId) => set((s) => {
      const node = SCENE.hierarchy.nodes.get(signalId);
      // Skip non-signals + unsupported signals (real/string/no-sample): the pack
      // path panics on a handle tide never ingested. The tree already disables
      // them; this guards other entry points.
      if (!node || node.kind !== "signal" || !node.supported) return s;
      const row = s.activeSignals.length;
      if (row >= MAX_ROWS) return s;
      return { activeSignals: [...s.activeSignals, withRowId(makeActiveRef(SCENE.hierarchy, signalId, row))] };
    }),
    // Append many signals in one set (e.g. "add all in scope") so there's a single
    // repack/render. Non-signal ids are skipped; appends stop at MAX_ROWS.
    addSignals: (signalIds) => set((s) => {
      let rows = s.activeSignals;
      for (const id of signalIds) {
        if (rows.length >= MAX_ROWS) break;
        const node = SCENE.hierarchy.nodes.get(id);
        if (!node || node.kind !== "signal" || !node.supported) continue;
        rows = [...rows, withRowId(makeActiveRef(SCENE.hierarchy, id, rows.length))];
      }
      return rows === s.activeSignals ? s : { activeSignals: rows };
    }),
    removeSignal: (row) => set((s) => ({
      activeSignals: renumber(s.activeSignals.filter((r) => r.row !== row)),
    })),
    removeSignals: (rows) => set((s) => {
      const kill = new Set(rows);
      return { activeSignals: renumber(s.activeSignals.filter((r) => !kill.has(r.row))) };
    }),
    moveSignal: (row, to) => set((s) => {
      const r = s.activeSignals.find((x) => x.row === row);
      if (!r) return s;
      const rest = s.activeSignals.filter((x) => x.row !== row);
      return { activeSignals: renumber(to === "top" ? [r, ...rest] : [...rest, r]) };
    }),
    moveSignals: (rows, to) => set((s) => {
      const move = new Set(rows);
      const picked = s.activeSignals.filter((r) => move.has(r.row));
      if (picked.length === 0) return s;
      const rest = s.activeSignals.filter((r) => !move.has(r.row));
      // Moved rows keep their relative order; whole block goes to top/bottom.
      return { activeSignals: renumber(to === "top" ? [...picked, ...rest] : [...rest, ...picked]) };
    }),
    setColor: (row, color) => set((s) => ({
      activeSignals: s.activeSignals.map((r) => (r.row === row ? { ...r, color } : r)),
    })),
    setRadix: (row, radix) => set((s) => ({
      activeSignals: s.activeSignals.map((r) => (r.row === row ? { ...r, radix } : r)),
    })),
    setRole: (row, role) => set((s) => ({
      activeSignals: s.activeSignals.map((r) => (r.row === row ? { ...r, role } : r)),
    })),
    setFormat: (row, radix, role) => set((s) => ({
      activeSignals: s.activeSignals.map((r) => (r.row === row ? { ...r, radix, role } : r)),
    })),
    setClockConfig: (row, clock) => set((s) => {
      const activeSignals = s.activeSignals.map((r) => (r.row === row ? { ...r, clock } : r));
      const changed = activeSignals.find((r) => r.row === row);
      // If the edited row is the timebase clock (and not manually overridden), a
      // polarity change re-detects the grid.
      if (changed && changed.path === s.timebaseClock && s.timebaseOverride == null) {
        return { activeSignals, clockGrid: computeTimebase(activeSignals, s.timebaseClock, null) };
      }
      return { activeSignals };
    }),
    setEnumTable: (row, enumTable) => set((s) => ({
      activeSignals: s.activeSignals.map((r) => (r.row === row ? { ...r, enumTable } : r)),
    })),
    setMute: (rows, mute) => set((s) => {
      const tgt = new Set(rows);
      return { activeSignals: s.activeSignals.map((r) => (tgt.has(r.row) ? { ...r, mute } : r)) };
    }),
    setRowHeight: (row, height) => set((s) => ({
      activeSignals: s.activeSignals.map((r) => (r.row === row ? { ...r, height } : r)),
    })),
    // Append a default-height (0) divider to row `row`'s gap.
    addDividerBelow: (row) => set((s) => ({
      activeSignals: s.activeSignals.map((r) => (r.row === row ? { ...r, dividers: [...(r.dividers ?? []), 0] } : r)),
    })),
    // Above row `row`: the previous row's gap, or the top gap when `row` is first.
    addDividerAbove: (row) => set((s) => (
      row <= 0
        ? { topDividers: [...s.topDividers, 0] }
        : { activeSignals: s.activeSignals.map((r) => (r.row === row - 1 ? { ...r, dividers: [...(r.dividers ?? []), 0] } : r)) }
    )),
    // Below the last row, or the top gap when there are no rows.
    addDividerBottom: () => set((s) => {
      const last = s.activeSignals.length - 1;
      if (last < 0) return { topDividers: [...s.topDividers, 0] };
      return { activeSignals: s.activeSignals.map((r) => (r.row === last ? { ...r, dividers: [...(r.dividers ?? []), 0] } : r)) };
    }),
    removeDivider: (t) => set((s) => {
      if (t.row < 0) return { topDividers: s.topDividers.filter((_, i) => i !== t.index) };
      return { activeSignals: s.activeSignals.map((r) => (r.row === t.row ? { ...r, dividers: (r.dividers ?? []).filter((_, i) => i !== t.index) } : r)) };
    }),
    setDividerHeight: (t, height) => set((s) => {
      const h = height ?? 0; // 0 = default
      if (t.row < 0) return { topDividers: s.topDividers.map((v, i) => (i === t.index ? h : v)) };
      return { activeSignals: s.activeSignals.map((r) => (r.row === t.row ? { ...r, dividers: (r.dividers ?? []).map((v, i) => (i === t.index ? h : v)) } : r)) };
    }),
    toggleHidden: (row) => set((s) => ({
      activeSignals: s.activeSignals.map((r) => (r.row === row ? { ...r, hidden: !r.hidden } : r)),
    })),
    hideOthers: (row) => set((s) => ({
      activeSignals: s.activeSignals.map((r) => ({ ...r, hidden: r.row !== row })),
    })),
    hideExcept: (rows) => set((s) => {
      const keep = new Set(rows);
      return { activeSignals: s.activeSignals.map((r) => ({ ...r, hidden: !keep.has(r.row) })) };
    }),
    toggleAllHidden: () => set((s) => {
      // Any row dimmed → show all; none dimmed → dim all.
      const next = !s.activeSignals.some((r) => r.hidden);
      return { activeSignals: s.activeSignals.map((r) => ({ ...r, hidden: next })) };
    }),
    selectRow: (row, opts) => set((s) => {
      // shift: contiguous range from the anchor to this row, replacing the rest.
      if (opts?.shift && selectionAnchor >= 0) {
        const lo = Math.min(selectionAnchor, row);
        const hi = Math.max(selectionAnchor, row);
        return { activeSignals: s.activeSignals.map((r) => ({ ...r, selected: r.row >= lo && r.row <= hi })) };
      }
      selectionAnchor = row;
      // ctrl/meta: toggle just this row, keep the rest of the selection.
      if (opts?.ctrl) {
        return { activeSignals: s.activeSignals.map((r) => (r.row === row ? { ...r, selected: !r.selected } : r)) };
      }
      // plain click: deselect all, select this one.
      return { activeSignals: s.activeSignals.map((r) => ({ ...r, selected: r.row === row })) };
    }),
    clearSelection: () => set((s) => (
      s.activeSignals.some((r) => r.selected)
        ? { activeSignals: s.activeSignals.map((r) => (r.selected ? { ...r, selected: false } : r)) }
        : s
    )),

    selectTreeNode: (id, opts, flatIds) => set((s) => {
      // shift: contiguous range over the flat-visible order, anchor → this node.
      if (opts?.shift && treeAnchor != null) {
        const a = flatIds.indexOf(treeAnchor);
        const b = flatIds.indexOf(id);
        if (a >= 0 && b >= 0) {
          const [lo, hi] = a < b ? [a, b] : [b, a];
          return { treeSelection: flatIds.slice(lo, hi + 1) };
        }
      }
      treeAnchor = id;
      // ctrl/meta: toggle just this node, keep the rest of the selection.
      if (opts?.ctrl) {
        return { treeSelection: s.treeSelection.includes(id)
          ? s.treeSelection.filter((x) => x !== id)
          : [...s.treeSelection, id] };
      }
      // plain click: select only this node.
      return { treeSelection: [id] };
    }),
    setTreeSelection: (ids) => set(() => { treeAnchor = ids.length ? ids[ids.length - 1] : null; return { treeSelection: ids }; }),
    clearTreeSelection: () => set((s) => (s.treeSelection.length ? (treeAnchor = null, { treeSelection: [] }) : s)),

    addMarkerAtCursor: () => set((s) => {
      // Rendering caps at MAX_MARKERS (shared line/pill pools); markers past it
      // would be invisible + un-grabbable, so stop adding rather than ghost them.
      if (s.markers.length >= MAX_MARKERS) return s;
      const id = markerSeq++;
      const color = MARKER_PALETTE[(id - 1) % MARKER_PALETTE.length];
      return {
        markers: [...s.markers, { id, name: `M${id}`, tick: clampTick(s.cursorTicks), color }],
        selectedMarkerId: id,
      };
    }),
    deleteMarker: (id) => set((s) => ({
      markers: s.markers.filter((m) => m.id !== id),
      selectedMarkerId: s.selectedMarkerId === id ? null : s.selectedMarkerId,
    })),
    selectMarker: (id) => set({ selectedMarkerId: id }),
    moveMarker: (id, tick) => set((s) => ({
      markers: s.markers.map((m) => (m.id === id ? { ...m, tick: clampTick(tick) } : m)),
    })),
    setMarkerTick: (id, tick) => set((s) => ({
      markers: s.markers.map((m) => (m.id === id ? { ...m, tick: clampTick(tick) } : m)),
    })),
    clearMarkers: () => set({ markers: [], selectedMarkerId: null }),
    // Select the next/prev marker in time order (wrapping) and park the cursor on
    // it. With nothing selected, dir>0 starts at the earliest, dir<0 at the latest.
    cycleMarker: (dir) => set((s) => {
      if (s.markers.length === 0) return s;
      const sorted = [...s.markers].sort((a, b) => a.tick - b.tick);
      const i = sorted.findIndex((m) => m.id === s.selectedMarkerId);
      const next = i < 0
        ? (dir > 0 ? sorted[0] : sorted[sorted.length - 1])
        : sorted[(i + dir + sorted.length) % sorted.length];
      return { selectedMarkerId: next.id, cursorTicks: next.tick };
    }),

    setCursor: (tick) => set({ cursorTicks: clampTick(tick) }),
    setViewRange: (start, end) => set({ viewRange: { start, end } }),
    bumpViewSave: () => set((s) => ({ viewSaveNonce: s.viewSaveNonce + 1 })),
    toggleSnap: () => set((s) => ({ snapCursor: !s.snapCursor })),
    toggleClock: () => set((s) => {
      if (s.clockAnchor) return { clockAnchor: false };
      // Turning on: ensure a timebase clock exists (auto-pick the first one).
      if (s.timebaseClock != null && s.clockGrid != null) return { clockAnchor: true };
      const fc = s.activeSignals.find((r) => r.role === "clock");
      if (!fc) return s; // nothing to anchor to
      return { clockAnchor: true, timebaseClock: fc.path, timebaseOverride: null, clockGrid: computeTimebase(s.activeSignals, fc.path, null) };
    }),
    // Select which clock drives the timebase (the on/off lives in clockAnchor,
    // toggled separately). Recomputes the grid; leaves clockAnchor untouched.
    setTimebaseClock: (path) => set((s) => ({
      timebaseClock: path,
      timebaseOverride: null,
      clockGrid: computeTimebase(s.activeSignals, path, null),
    })),
    setTimebaseOverride: (period, phase) => set((s) => {
      if (s.timebaseClock == null) return s;
      // Reject a non-positive / non-finite period (would hang the grid loops).
      if (!(period > 0) || !isFinite(period) || !isFinite(phase)) return s;
      return { timebaseOverride: { period, phase }, clockGrid: { period, phase, valid: true } };
    }),

    toggleScope: (id) => set((s) => ({
      expandedScopes: s.expandedScopes.includes(id)
        ? s.expandedScopes.filter((x) => x !== id)
        : [...s.expandedScopes, id],
    })),
    setExpanded: (ids) => set({ expandedScopes: ids }),

    setTreeWidth: (w) => set((s) => ({ panels: { ...s.panels, treeWidth: w } })),
    setActiveWidth: (w) => set((s) => ({ panels: { ...s.panels, activeWidth: w } })),
    setTreeCollapsed: (v) => set((s) => ({ panels: { ...s.panels, treeCollapsed: v } })),
    setActiveCollapsed: (v) => set((s) => ({ panels: { ...s.panels, activeCollapsed: v } })),
    setActiveCompactWidth: (w) => set((s) => ({ panels: { ...s.panels, activeCompactWidth: w } })),

    setHover: (h) => set({ hover: h }),
    setPicker: (p) => set({ picker: p }),
    setCtxMenu: (m) => set({ ctxMenu: m }),
    setEnumDialog: (d) => set({ enumDialog: d }),

    resetForTrace: () => set((st) => ({ ...hydrateDoc(), ...freshUi(), traceNonce: st.traceNonce + 1 })),
    setTraceStale: (v) => set({ traceStale: v }),
  })),
);

export const useAppStore = create(vanilla);

// ---- sidecar (clean export) ---------------------------------------------
// Thin adapter onto the existing framework-agnostic serializer — the document
// slice is shaped to be exactly its argument. Format/backend unchanged.
function sidecarSnapshot(s: AppState): SidecarSnapshot {
  return {
    hierarchy: SCENE.hierarchy,
    activeSignals: s.activeSignals,
    topDividers: s.topDividers,
    time: { start: s.viewRange.start, end: s.viewRange.end, cursor: s.cursorTicks },
    markers: s.markers.map((m) => ({
      name: m.name, tick: m.tick, color: m.color, selected: m.id === s.selectedMarkerId,
    })),
    panels: s.panels,
    treeExpanded: new Set(s.expandedScopes),
    toggles: { snapCursor: s.snapCursor, clockAnchor: s.clockAnchor },
    timebase: { clockPath: s.timebaseClock, override: s.timebaseOverride },
  };
}

export function selectSidecarText(s: AppState): string {
  return sidecarToString(serializeSidecar(sidecarSnapshot(s)));
}

// Portable export: same view (time range, active signals, markers) but with the
// UI-chrome section (panel sizes, tree-expansion, tabs) stripped, so the file
// describes only what to show, not how this window was laid out.
export function selectExportSidecarText(s: AppState): string {
  const { ui: _ui, ...view } = serializeSidecar(sidecarSnapshot(s));
  return sidecarToString(view);
}

// Auto-write the sidecar on discrete document changes. Selects everything that
// persists EXCEPT viewRange (excluded so per-frame rAF setViewRange doesn't
// thrash the file) but INCLUDING viewSaveNonce (the pan/zoom settle trigger).
// subscribe doesn't fire on initial state, so the first fire is a real change;
// lastSaved seeds from the hydrated state. Returns the unsubscribe fn.
export function startAutosave(): () => void {
  let lastSaved = selectSidecarText(useAppStore.getState());
  return useAppStore.subscribe(
    (s) => [
      s.activeSignals, s.topDividers, s.markers, s.selectedMarkerId, s.snapCursor, s.clockAnchor,
      s.timebaseClock, s.timebaseOverride,
      s.panels, s.expandedScopes, s.cursorTicks, s.viewSaveNonce,
    ] as const,
    () => {
      const text = selectSidecarText(useAppStore.getState());
      if (text === lastSaved) return;
      lastSaved = text;
      writeSidecarFile(sidecarPath(), text);
    },
    { equalityFn: shallow },
  );
}
