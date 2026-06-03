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

import { SCENE, INITIAL, makeActiveRef, type ActiveSignalRef, type Radix } from "../hier/scene";
import type { NodeId } from "../hier/types";
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
  expandedScopes: NodeId[]; // array (not Set) so reconcile/serialization stay simple
  panels: PanelState;
  tabs: { open: string[]; active: number };
}

export interface UiState {
  hover: { tick: number; row: number } | null;
  picker: { row: number; anchorRect: DOMRect } | null;
  ctxMenu: { x: number; y: number; row: number } | null;
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
  removeSignal: (row: number) => void;
  setColor: (row: number, color: string) => void;
  setRadix: (row: number, radix: Radix) => void;
  toggleHidden: (row: number) => void;
  selectRow: (row: number) => void;
  clearSelection: () => void;

  addMarkerAtCursor: () => void;
  deleteMarker: (id: number) => void;
  selectMarker: (id: number | null) => void;
  moveMarker: (id: number, tick: number) => void;
  setMarkerTick: (id: number, tick: number) => void;

  setCursor: (tick: number) => void;
  setViewRange: (start: number, end: number) => void;
  bumpViewSave: () => void;
  toggleSnap: () => void;
  toggleClock: () => void;

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
  setPicker: (p: { row: number; anchorRect: DOMRect } | null) => void;
  setCtxMenu: (m: { x: number; y: number; row: number } | null) => void;

  // Re-seed the whole document slice from the freshly-swapped SCENE/INITIAL (the
  // caller runs scene.swapTrace first). One atomic set → subscribers fire once.
  resetForTrace: () => void;
}

export type AppState = DocState & UiState & Actions;

// ---- monotonic counters (module-scoped latches, never rendered) ---------
let rowSeq = 1;   // unique row id; never reused, so <For>/reconcile identity is stable
let markerSeq = 1; // unique marker id/name; deletes never reuse a name

const withRowId = (r: ActiveSignalRef): Row => ({ ...r, id: rowSeq++ });

// ---- hydration ----------------------------------------------------------

function hydrateDoc(): DocState {
  const markers: Marker[] = INITIAL.markers.map((m, i) => ({
    id: i + 1, name: m.name, tick: m.tick, color: m.color,
  }));
  markerSeq = markers.length + 1;
  const selIdx = INITIAL.markers.findIndex((m) => m.selected);
  return {
    activeSignals: SCENE.activeSignals.map(withRowId),
    markers,
    selectedMarkerId: selIdx >= 0 ? selIdx + 1 : null,
    cursorTicks: INITIAL.time.cursor,
    viewRange: { start: INITIAL.time.start, end: INITIAL.time.end },
    snapCursor: INITIAL.toggles.snapCursor,
    clockAnchor: INITIAL.toggles.clockAnchor,
    expandedScopes: [...SCENE.initialExpanded],
    panels: { ...INITIAL.panels },
    tabs: { open: [...INITIAL.tabs.open], active: INITIAL.tabs.active },
  };
}

const freshUi = (): Omit<UiState, "traceNonce"> => ({ hover: null, picker: null, ctxMenu: null, viewSaveNonce: 0 });

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
    removeSignal: (row) => set((s) => ({
      activeSignals: renumber(s.activeSignals.filter((r) => r.row !== row)),
    })),
    setColor: (row, color) => set((s) => ({
      activeSignals: s.activeSignals.map((r) => (r.row === row ? { ...r, color } : r)),
    })),
    setRadix: (row, radix) => set((s) => ({
      activeSignals: s.activeSignals.map((r) => (r.row === row ? { ...r, radix } : r)),
    })),
    toggleHidden: (row) => set((s) => ({
      activeSignals: s.activeSignals.map((r) => (r.row === row ? { ...r, hidden: !r.hidden } : r)),
    })),
    selectRow: (row) => set((s) => {
      const wasSelected = s.activeSignals.find((r) => r.row === row)?.selected ?? false;
      return { activeSignals: s.activeSignals.map((r) => ({ ...r, selected: !wasSelected && r.row === row })) };
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

    setCursor: (tick) => set({ cursorTicks: tick }),
    setViewRange: (start, end) => set({ viewRange: { start, end } }),
    bumpViewSave: () => set((s) => ({ viewSaveNonce: s.viewSaveNonce + 1 })),
    toggleSnap: () => set((s) => ({ snapCursor: !s.snapCursor })),
    toggleClock: () => set((s) => ({ clockAnchor: !s.clockAnchor })),

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
