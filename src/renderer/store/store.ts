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

import { SCENE, INITIAL, makeActiveRef, handleForPath, type ActiveSignalRef, type Radix, type ActiveRole, type ClockConfig, type EnumEntry } from "../hier/scene";
import type { NodeId } from "../hier/types";
import type { ClockGrid } from "../wave/format";
import { detectClockGrid, detectResetBand } from "../wave/clock";
import { MAX_ROWS } from "../gpu/colors";
import {
  serializeSidecar,
  sidecarToString,
  writeSidecarFile,
  sidecarPath,
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

export interface DocState {
  activeSignals: Row[];
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
  // clock + the first reset signal): the detected cycle grid + reset-held band.
  clockGrid: ClockGrid | null;
  resetBand: { tStart: number; tEnd: number } | null;
  expandedScopes: NodeId[]; // array (not Set) so reconcile/serialization stay simple
  panels: PanelState;
  tabs: { open: string[]; active: number };
}

export interface UiState {
  hover: { tick: number; row: number } | null;
  // `row` anchors the swatch/Coloris; `rows` (optional) is the full set the chosen
  // color is applied to (a selection from the context menu). Defaults to [row].
  picker: { row: number; rows?: number[]; anchorRect: DOMRect } | null;
  ctxMenu: { x: number; y: number; row: number } | null;
  enumDialog: { row: number } | null;
  // Bumped on viewport-settle (pan end / wheel / zoom-anim end) so the autosave
  // persists the final window — viewRange itself is excluded from the save
  // trigger (the rAF loop writes it per frame during interaction).
  viewSaveNonce: number;
  // Bumped by resetForTrace (in-app Open VCD…). The canvas subscribes to it to
  // reset the viewport + re-instrument perf; the repack/colors flow through the
  // normal activeSignals subscriptions since the active set changes too.
  traceNonce: number;
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
  // Per-row vertical size (CSS px). undefined resets to the default ROW_HEIGHT_CSS.
  setRowHeight: (row: number, height: number | undefined) => void;
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

  setActiveTab: (i: number) => void;
  closeTab: (i: number) => void;

  setHover: (h: { tick: number; row: number } | null) => void;
  setPicker: (p: { row: number; rows?: number[]; anchorRect: DOMRect } | null) => void;
  setCtxMenu: (m: { x: number; y: number; row: number } | null) => void;
  setEnumDialog: (d: { row: number } | null) => void;

  // Re-seed the whole document slice from the freshly-swapped SCENE/INITIAL (the
  // caller runs scene.swapTrace first). One atomic set → subscribers fire once.
  resetForTrace: () => void;
}

export type AppState = DocState & UiState & Actions;

// ---- monotonic counters (module-scoped latches, never rendered) ---------
let rowSeq = 1;   // unique row id; never reused, so <For>/reconcile identity is stable
let markerSeq = 1; // unique marker id/name; deletes never reuse a name
let selectionAnchor = -1; // last single/ctrl-selected row; shift-range pivots here

const withRowId = (r: ActiveSignalRef): Row => ({ ...r, id: rowSeq++ });

// Detect the cycle grid (from the timebase clock, unless overridden) and the
// reset-held band (from the first role:"reset" row). Pure read of the prefix of
// each signal via native getEdges. Returns nulls when nothing resolves.
function computeTimebase(
  active: readonly ActiveSignalRef[],
  clockPath: string | null,
  override: { period: number; phase: number } | null,
): { clockGrid: ClockGrid | null; resetBand: { tStart: number; tEnd: number } | null } {
  let clockGrid: ClockGrid | null = null;
  if (clockPath != null) {
    const handle = handleForPath(clockPath);
    if (handle != null) {
      if (override) clockGrid = { period: override.period, phase: override.phase, valid: true };
      else {
        const polarity = active.find((r) => r.path === clockPath)?.clock?.polarity ?? "rising";
        clockGrid = detectClockGrid(handle, polarity);
      }
    }
  }
  let resetBand: { tStart: number; tEnd: number } | null = null;
  const resetRow = active.find((r) => r.role === "reset");
  if (resetRow) {
    const h = handleForPath(resetRow.path);
    if (h != null) resetBand = detectResetBand(h);
  }
  return { clockGrid, resetBand };
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
  const { clockGrid, resetBand } = computeTimebase(active, timebaseClock, timebaseOverride);
  // A saved/auto clock absent from this trace → fall back to absolute time.
  if (timebaseClock != null && clockGrid == null) { timebaseClock = null; clockAnchor = false; }

  return {
    activeSignals: active.map(withRowId),
    markers,
    selectedMarkerId: selIdx >= 0 ? selIdx + 1 : null,
    cursorTicks: INITIAL.time.cursor,
    viewRange: { start: INITIAL.time.start, end: INITIAL.time.end },
    snapCursor: INITIAL.toggles.snapCursor,
    clockAnchor,
    timebaseClock,
    timebaseOverride,
    clockGrid,
    resetBand,
    expandedScopes: [...SCENE.initialExpanded],
    panels: { ...INITIAL.panels },
    tabs: { open: [...INITIAL.tabs.open], active: INITIAL.tabs.active },
  };
}

const freshUi = (): Omit<UiState, "traceNonce"> => ({ hover: null, picker: null, ctxMenu: null, enumDialog: null, viewSaveNonce: 0 });

// Renumber rows so `row` stays the contiguous 0..N-1 canvas/Y slot. Keeps each
// surviving row's `id` (identity) so reconcile/<For> reuse its DOM.
const renumber = (rows: Row[]): Row[] => rows.map((r, i) => (r.row === i ? r : { ...r, row: i }));

// ---- store --------------------------------------------------------------

const vanilla = createVanilla<AppState>()(
  subscribeWithSelector((set, get) => ({
    ...hydrateDoc(),
    ...freshUi(),
    traceNonce: 0,

    addSignal: (signalId) => set((s) => {
      const node = SCENE.hierarchy.nodes.get(signalId);
      if (!node || node.kind !== "signal") return s;
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
        if (!node || node.kind !== "signal") continue;
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
        return { activeSignals, clockGrid: computeTimebase(activeSignals, s.timebaseClock, null).clockGrid };
      }
      return { activeSignals };
    }),
    setEnumTable: (row, enumTable) => set((s) => ({
      activeSignals: s.activeSignals.map((r) => (r.row === row ? { ...r, enumTable } : r)),
    })),
    setRowHeight: (row, height) => set((s) => ({
      activeSignals: s.activeSignals.map((r) => (r.row === row ? { ...r, height } : r)),
    })),
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

    addMarkerAtCursor: () => set((s) => {
      const id = markerSeq++;
      const color = MARKER_PALETTE[(id - 1) % MARKER_PALETTE.length];
      return {
        markers: [...s.markers, { id, name: `M${id}`, tick: s.cursorTicks, color }],
        selectedMarkerId: id,
      };
    }),
    deleteMarker: (id) => set((s) => ({
      markers: s.markers.filter((m) => m.id !== id),
      selectedMarkerId: s.selectedMarkerId === id ? null : s.selectedMarkerId,
    })),
    selectMarker: (id) => set({ selectedMarkerId: id }),
    moveMarker: (id, tick) => set((s) => ({
      markers: s.markers.map((m) => (m.id === id ? { ...m, tick } : m)),
    })),
    setMarkerTick: (id, tick) => set((s) => ({
      markers: s.markers.map((m) => (m.id === id ? { ...m, tick } : m)),
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

    setCursor: (tick) => set({ cursorTicks: tick }),
    setViewRange: (start, end) => set({ viewRange: { start, end } }),
    bumpViewSave: () => set((s) => ({ viewSaveNonce: s.viewSaveNonce + 1 })),
    toggleSnap: () => set((s) => ({ snapCursor: !s.snapCursor })),
    toggleClock: () => set((s) => {
      if (s.clockAnchor) return { clockAnchor: false };
      // Turning on: ensure a timebase clock exists (auto-pick the first one).
      if (s.timebaseClock != null && s.clockGrid != null) return { clockAnchor: true };
      const fc = s.activeSignals.find((r) => r.role === "clock");
      if (!fc) return s; // nothing to anchor to
      return { clockAnchor: true, timebaseClock: fc.path, timebaseOverride: null, clockGrid: computeTimebase(s.activeSignals, fc.path, null).clockGrid };
    }),
    // Select which clock drives the timebase (the on/off lives in clockAnchor,
    // toggled separately). Recomputes the grid; leaves clockAnchor untouched.
    setTimebaseClock: (path) => set((s) => ({
      timebaseClock: path,
      timebaseOverride: null,
      clockGrid: computeTimebase(s.activeSignals, path, null).clockGrid,
    })),
    setTimebaseOverride: (period, phase) => set((s) => {
      if (s.timebaseClock == null) return s;
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

    setActiveTab: (i) => set({ tabs: { ...get().tabs, active: i } }),
    closeTab: (i) => set((s) => {
      const open = s.tabs.open.filter((_, k) => k !== i);
      const active = s.tabs.active >= i && s.tabs.active > 0 ? s.tabs.active - 1 : s.tabs.active;
      return { tabs: { open, active } };
    }),

    setHover: (h) => set({ hover: h }),
    setPicker: (p) => set({ picker: p }),
    setCtxMenu: (m) => set({ ctxMenu: m }),
    setEnumDialog: (d) => set({ enumDialog: d }),

    resetForTrace: () => set((st) => ({ ...hydrateDoc(), ...freshUi(), traceNonce: st.traceNonce + 1 })),
  })),
);

export const useAppStore = create(vanilla);

// ---- sidecar (clean export) ---------------------------------------------
// Thin adapter onto the existing framework-agnostic serializer — the document
// slice is shaped to be exactly its argument. Format/backend unchanged.
export function selectSidecarText(s: AppState): string {
  return sidecarToString(
    serializeSidecar({
      hierarchy: SCENE.hierarchy,
      trace: { id: "keysched" },
      activeSignals: s.activeSignals,
      time: { start: s.viewRange.start, end: s.viewRange.end, cursor: s.cursorTicks },
      markers: s.markers.map((m) => ({
        name: m.name, tick: m.tick, color: m.color, selected: m.id === s.selectedMarkerId,
      })),
      panels: s.panels,
      treeExpanded: new Set(s.expandedScopes),
      toggles: { snapCursor: s.snapCursor, clockAnchor: s.clockAnchor },
      timebase: { clockPath: s.timebaseClock, override: s.timebaseOverride },
      tabs: { open: s.tabs.open, active: s.tabs.active },
    }),
  );
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
      s.activeSignals, s.markers, s.selectedMarkerId, s.snapCursor, s.clockAnchor,
      s.timebaseClock, s.timebaseOverride,
      s.panels, s.expandedScopes, s.tabs, s.cursorTicks, s.viewSaveNonce,
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
