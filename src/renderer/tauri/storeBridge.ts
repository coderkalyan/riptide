// Zustand ⇄ Rust document sync for the Tauri build.
//
// Downstream: subscribes the store's document slice (active rows + markers +
// cursor + toggles + timebase — everything Rust packs/renders from) and pushes
// a contract DocSync via bridge.syncDoc on each change, with a monotonically
// increasing generation. Row specs reuse hier/scene.ts's pack-spec logic
// (packSpecsFor) so kind/shade/mute/enum resolution stays identical to the
// Electron path, extended with the render cosmetics RowSpec carries.
//
// Upstream: bridge.subscribeEvents maps UiEvents into store mutations under an
// `applyingRemote` guard so a Rust-originated change never echoes back as a
// syncDoc. Display-text events (cursor row values, hover readout) go to
// tauri/valuesStash.ts, not the store.

import { shallow } from "zustand/shallow";
import * as bridge from "../ipc/bridge";
import type { DocSync, RowSpec, UiEvent } from "../ipc/types";
import { useAppStore, type AppState, type Row } from "../store/store";
import { packSpecsFor, SCENE } from "../hier/scene";
import { getSignal } from "../hier/hierarchy";
import { hexToPacked } from "../hier/sidecar";
import { setTauriHover, setTauriRowValues } from "./valuesStash";

let generation = 0;
let applyingRemote = false;

function guard(fn: () => void): void {
  applyingRemote = true;
  try {
    fn();
  } finally {
    applyingRemote = false;
  }
}

function rowSpecs(rows: Row[]): RowSpec[] {
  const specs = packSpecsFor(rows); // row/handle/kind/polarity/shaded/muteHandle/radix/enums
  return rows.map((r, i) => ({
    ...specs[i],
    path: r.path,
    color: hexToPacked(r.color),
    hidden: !!r.hidden,
    selected: !!r.selected,
    height: r.height ?? null,
    dividerBelow: !!r.dividerBelow,
    dividerHeight: r.dividerHeight ?? null,
    bitWidth: getSignal(SCENE.hierarchy, r.signalId).bitWidth,
  }));
}

function buildDocSync(s: AppState): DocSync {
  return {
    rows: rowSpecs(s.activeSignals),
    markers: s.markers.map((m) => ({ id: m.id, name: m.name, tick: m.tick, color: m.color })),
    selectedMarker: s.selectedMarkerId,
    cursor: s.cursorTicks,
    snapCursor: s.snapCursor,
    clockAnchor: s.clockAnchor,
    timebaseClock: s.timebaseClock,
    timebaseOverride: s.timebaseOverride,
    generation: ++generation,
  };
}

function pushDoc(): void {
  void bridge
    .syncDoc(buildDocSync(useAppStore.getState()))
    .catch((e) => console.warn("[tauri] syncDoc failed", e));
}

function onUiEvent(ev: UiEvent): void {
  const st = useAppStore.getState();
  switch (ev.type) {
    case "viewportChanged":
      guard(() => {
        st.setViewRange(ev.start, ev.end);
        if (ev.settled) st.bumpViewSave();
      });
      break;
    case "cursorMoved":
      setTauriRowValues(ev.rowValues);
      guard(() => st.setCursor(ev.tick));
      break;
    case "hoverChanged":
      setTauriHover({ tick: ev.tick, row: ev.row, timeLabel: ev.timeLabel, valueText: ev.valueText });
      guard(() => st.setHover({ tick: ev.tick, row: ev.row }));
      break;
    case "hoverCleared":
      setTauriHover(null);
      guard(() => st.setHover(null));
      break;
    case "markerMoved":
      guard(() => st.setMarkerTick(ev.id, ev.tick));
      break;
    case "markerSelected":
      guard(() => st.selectMarker(ev.id));
      break;
    case "clockGridChanged":
      // The store has no action for the derived grid (Electron computes it
      // locally); write the slice directly — the canonical detection lives in
      // Rust here.
      guard(() => useAppStore.setState({ clockGrid: ev.grid }));
      break;
    case "traceLoaded":
      // TODO(U15 integration): in-app "Open VCD…" lands here — re-marshal the
      // hierarchy, swap the scene, resetForTrace. Boot-time loads are handled
      // by index.tauri.tsx before this subscription starts.
      console.info("[tauri] traceLoaded", ev.summary);
      break;
    case "perf":
      // U14 wires the perf HUD to these samples.
      break;
  }
}

/**
 * Start both directions. Pushes the current document immediately (so Rust has
 * the boot view), then keeps it in sync. Returns the downstream unsubscribe.
 */
export function startStoreBridge(): () => void {
  pushDoc();
  const unsub = useAppStore.subscribe(
    (s) => [
      s.activeSignals, s.markers, s.selectedMarkerId, s.cursorTicks,
      s.snapCursor, s.clockAnchor, s.timebaseClock, s.timebaseOverride,
    ] as const,
    () => {
      if (applyingRemote) return;
      pushDoc();
    },
    { equalityFn: shallow },
  );
  void bridge
    .subscribeEvents(onUiEvent)
    .catch((e) => console.warn("[tauri] subscribeEvents failed", e));
  return unsub;
}
