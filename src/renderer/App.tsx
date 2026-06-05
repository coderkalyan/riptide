import { For, Show, createSignal, createMemo, onMount, onCleanup } from "solid-js";
import { X, PanelLeftClose, PanelLeftOpen } from "lucide-solid";
import { useAppStore } from "./store/store";
import { WaveCanvas } from "./wave/WaveCanvas";
import { ActiveSignals } from "./ActiveSignals";
import { HoverReadout } from "./HoverReadout";
import { ColorPicker } from "./ColorPicker";
import { ContextMenu, activeSignalMenu } from "./ContextMenu";
import { EnumDialog } from "./EnumDialog";
import { SignalTree } from "./SignalTree";
import { WavesToolbar } from "./WavesToolbar";
import { MarkersBar } from "./MarkersBar";
import { MenuBar } from "./MenuBar";
import { GlobalTooltip } from "./GlobalTooltip";
import { PerfOverlay } from "./PerfOverlay";
import { buildEnumLabels } from "./wave/value";
import { getSignal } from "./hier/hierarchy";
import { SCENE, swapTrace } from "./hier/scene";
import { view } from "./wave/viewport";
import { ZOOM_STEP } from "./wave/constants";
import * as perf from "./perf";

declare const require: (m: string) => unknown;

// Ask the main process to show the Open-VCD dialog. Returns the chosen path (or
// null if cancelled); the renderer then swaps the trace in place — no reload.
function ipc(): { invoke(channel: string, ...args: unknown[]): Promise<unknown> } | null {
  try {
    return (require("electron") as { ipcRenderer: { invoke(channel: string, ...args: unknown[]): Promise<unknown> } }).ipcRenderer;
  } catch (e) {
    console.error("[ipc] unavailable", e);
    return null;
  }
}

async function openVcdDialog(): Promise<string | null> {
  return ((await ipc()?.invoke("riptide:open-vcd")) as string | null) ?? null;
}

const TREE_MIN_PX = 160;
const ACTIVE_MIN_PX = 200;
const TREE_COLLAPSED_PX = 28;
const TREE_DEFAULT_PX = 236;
const ACTIVE_DEFAULT_PX = 296;
const ACTIVE_COMPACT_MIN_PX = 88;

export function App() {
  const s = useAppStore();
  // Shared per-row enum label maps — feeds the value column + hover readout.
  const enumLabels = createMemo(() => buildEnumLabels(s.activeSignals));

  // Web-font load → re-measure the compact width (fallback metrics are narrower).
  const [fontTick, setFontTick] = createSignal(0);
  onMount(() => { document.fonts?.ready.then(() => setFontTick((t) => t + 1)); });

  // Compact-strip width: hug the longest signal name as a concrete px value (so
  // the collapse/expand slide animates px→px), floored to the header width.
  const compactW = createMemo(() => {
    fontTick(); // re-measure when the web font loads
    const ctx = document.createElement("canvas").getContext("2d");
    if (!ctx) return ACTIVE_COMPACT_MIN_PX;
    ctx.font = "12px 'JetBrains Mono', monospace";
    let max = 0;
    for (const ref of s.activeSignals) {
      const w = ctx.measureText(getSignal(SCENE.hierarchy, ref.signalId).name).width;
      if (w > max) max = w;
    }
    ctx.font = "600 11.5px 'IBM Plex Sans', system-ui, sans-serif";
    const title = "ACTIVE SIGNALS";
    const headerW = ctx.measureText(title).width + title.length * 0.4 + 43;
    return Math.max(ACTIVE_COMPACT_MIN_PX, Math.ceil(headerW), Math.ceil(max) + 18);
  });

  const treeColW = () => (s.panels.treeCollapsed ? TREE_COLLAPSED_PX : s.panels.treeWidth);
  const activeColW = () => (s.panels.activeCollapsed ? (s.panels.activeCompactWidth ?? compactW()) : s.panels.activeWidth);

  // The grid-column width transition is always-on (see `.body` CSS) so a
  // collapse/expand toggle animates even though it remounts the panel content
  // in the same tick — `dragging` switches it off so live drag stays 1:1.
  const [dragging, setDragging] = createSignal(false);
  const [rowSliding, setRowSliding] = createSignal(false);
  let rowSlideTimer: number | null = null;
  const [treeToggling, setTreeToggling] = createSignal(false);
  let treeToggleTimer: number | null = null;
  const toggleTree = (collapsed: boolean) => {
    s.setTreeCollapsed(collapsed);
    setTreeToggling(true);
    if (treeToggleTimer != null) clearTimeout(treeToggleTimer);
    treeToggleTimer = window.setTimeout(() => setTreeToggling(false), 140);
  };
  const toggleActive = (collapsed: boolean) => {
    s.setActiveCollapsed(collapsed);
    setRowSliding(true);
    if (rowSlideTimer != null) clearTimeout(rowSlideTimer);
    rowSlideTimer = window.setTimeout(() => setRowSliding(false), 240);
  };
  const startResize = (which: "tree" | "active" | "activeCompact") => (e: PointerEvent & { currentTarget: HTMLDivElement }) => {
    e.preventDefault();
    const startX = e.clientX;
    const startTree = s.panels.treeWidth;
    const startActive = s.panels.activeWidth;
    const startCompact = s.panels.activeCompactWidth ?? compactW();
    const target = e.currentTarget;
    target.setPointerCapture(e.pointerId);
    setDragging(true);
    const onMove = (ev: PointerEvent) => {
      const dx = ev.clientX - startX;
      if (which === "tree") s.setTreeWidth(Math.max(TREE_MIN_PX, startTree + dx));
      else if (which === "activeCompact") s.setActiveCompactWidth(Math.max(ACTIVE_COMPACT_MIN_PX, startCompact + dx));
      else s.setActiveWidth(Math.max(ACTIVE_MIN_PX, startActive + dx));
    };
    const onUp = (ev: PointerEvent) => {
      target.releasePointerCapture(ev.pointerId);
      setDragging(false);
      target.removeEventListener("pointermove", onMove);
      target.removeEventListener("pointerup", onUp);
      target.removeEventListener("pointercancel", onUp);
    };
    target.addEventListener("pointermove", onMove);
    target.addEventListener("pointerup", onUp);
    target.addEventListener("pointercancel", onUp);
  };

  // Swap to a new trace in place (no window reload): reassign SCENE/INITIAL, then
  // one atomic store reset re-hydrates the doc slice + bumps traceNonce → the
  // canvas resets the viewport and the activeSignals subscriptions repack.
  const handleOpenVcd = async () => {
    const p = await openVcdDialog();
    if (!p) return;
    perf.beginSwap();
    swapTrace(p);
    s.resetForTrace();
  };

  // Open a recent trace: note it as opened (bumps the recent list main-side),
  // then swap in place — same path as handleOpenVcd minus the dialog.
  const handleOpenRecent = async (p: string) => {
    await ipc()?.invoke("riptide:open-recent", p);
    perf.beginSwap();
    swapTrace(p);
    s.resetForTrace();
  };

  const getRecent = async () => ((await ipc()?.invoke("riptide:recent-vcds")) as string[] | null) ?? [];
  const closeWindow = () => { ipc()?.invoke("riptide:close-window"); };

  const zoomIn = () => view.zoomBy(1 / ZOOM_STEP);
  const zoomOut = () => view.zoomBy(ZOOM_STEP);
  const zoomFit = () => view.fitView();

  const deleteSelMarker = () => { if (s.selectedMarkerId != null) s.deleteMarker(s.selectedMarkerId); };

  // Signals menu: operate on the selected active-signal row (mirrors the row's
  // right-click menu). Color anchors to the selected row's pin swatch so Coloris
  // opens in the same spot as clicking the pin directly.
  const selSignal = () => s.activeSignals.find((r) => r.selected);
  const onSignalColor = () => {
    const r = selSignal();
    if (!r) return;
    const pin = document.querySelector(".s-row.sel .pin");
    const rect = pin ? pin.getBoundingClientRect() : new DOMRect(220, 90, 0, 0);
    s.setPicker({ row: r.row, anchorRect: rect });
  };

  // Global keyboard shortcuts mirroring the File/View menus.
  onMount(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.ctrlKey || e.altKey) return;
      const k = e.key.toLowerCase();
      if (!e.shiftKey && k === "o") { e.preventDefault(); handleOpenVcd(); }
      // Ctrl+= / Ctrl++ zoom in, Ctrl+- zoom out, Ctrl+0 fit. "=" is the unshifted
      // "+" key, so accept both; the numpad sends "Add"/"Subtract".
      else if (k === "=" || k === "+") { e.preventDefault(); zoomIn(); }
      else if (k === "-" || k === "_") { e.preventDefault(); zoomOut(); }
      else if (k === "0") { e.preventDefault(); zoomFit(); }
    };
    document.addEventListener("keydown", onKey);
    onCleanup(() => document.removeEventListener("keydown", onKey));
  });

  return (
    <div class="app">
      <div class="titlebar">
        <div class="dots"><i class="r" /><i class="y" /><i class="g" /></div>
        <div class="title">Riptide</div>
        <MenuBar
          onOpenVcd={handleOpenVcd} onOpenRecent={handleOpenRecent} getRecent={getRecent} onCloseWindow={closeWindow}
          onZoomIn={zoomIn} onZoomOut={zoomOut} onZoomFit={zoomFit}
          treeCollapsed={() => s.panels.treeCollapsed} onToggleTree={toggleTree}
          activeCollapsed={() => s.panels.activeCollapsed} onToggleActive={toggleActive}
          snapOn={() => s.snapCursor} onToggleSnap={() => s.toggleSnap()}
          clockOn={() => s.clockAnchor} onToggleClock={() => s.toggleClock()}
          markerCount={() => s.markers.length} markerSelected={() => s.selectedMarkerId != null}
          onMarkerAdd={() => s.addMarkerAtCursor()} onMarkerDelete={deleteSelMarker}
          onMarkerClear={() => s.clearMarkers()} onMarkerNext={() => s.cycleMarker(1)} onMarkerPrev={() => s.cycleMarker(-1)}
          signalSelected={() => s.activeSignals.some((r) => r.selected)}
          signalHidden={() => selSignal()?.hidden ?? false}
          onSignalHide={() => { const r = selSignal(); if (r) s.toggleHidden(r.row); }}
          onSignalColor={onSignalColor}
          onSignalMoveTop={() => { const r = selSignal(); if (r) s.moveSignal(r.row, "top"); }}
          onSignalMoveBottom={() => { const r = selSignal(); if (r) s.moveSignal(r.row, "bottom"); }}
          onSignalRemove={() => { const r = selSignal(); if (r) s.removeSignal(r.row); }}
        />
        <div class="divider" />
        <div class="tabs">
          <For each={s.tabs.open}>{(f, i) => (
            <span class={`tab${i() === s.tabs.active ? " active" : ""}`} onClick={() => s.setActiveTab(i())}>
              {f}
              <span class="tab-close" data-tip="close file" onClick={(e) => { e.stopPropagation(); s.closeTab(i()); }}><X size={11} /></span>
            </span>
          )}</For>
        </div>
        <div class="sp" />
      </div>

      <div
        class={`body${dragging() ? " dragging" : ""}`}
        style={{ "grid-template-columns": `${treeColW()}px ${activeColW()}px 1fr`, "grid-template-rows": "minmax(0, 1fr) auto" }}
      >
        <Show when={!s.panels.treeCollapsed}>
          <div class="col-resize" style={{ left: `${treeColW() - 3}px` }} onPointerDown={startResize("tree")} onDblClick={() => s.setTreeWidth(TREE_DEFAULT_PX)} />
        </Show>
        <div
          class="col-resize"
          style={{ left: `${treeColW() + activeColW() - 3}px` }}
          onPointerDown={startResize(s.panels.activeCollapsed ? "activeCompact" : "active")}
          onDblClick={() => { if (s.panels.activeCollapsed) s.setActiveCompactWidth(null); else s.setActiveWidth(ACTIVE_DEFAULT_PX); }}
        />

        <div class="col">
          <Show
            when={s.panels.treeCollapsed && !treeToggling()}
            fallback={
              <div class="col-inner" style={{ width: `${s.panels.treeWidth}px` }}>
                <div class="col-head" style={{ "padding-right": "3px" }}>
                  <h3>Signal Tree</h3>
                  <span class="sp" style={{ flex: 1 }} />
                  <span class="collapse" data-tip="collapse panel" onClick={() => toggleTree(true)}><PanelLeftClose size={14} stroke-width={1.75} /></span>
                </div>
                <div class="col-sub"><input class="search" placeholder="filter scope/name" /></div>
                <SignalTree />
              </div>
            }
          >
            <div class="col-head" style={{ "justify-content": "center" }}>
              <span class="collapse" data-tip="expand panel" onClick={() => toggleTree(false)}><PanelLeftOpen size={14} stroke-width={1.75} /></span>
            </div>
            <div class="col-vtitle">Signal Tree</div>
          </Show>
        </div>

        <ActiveSignals enumLabels={enumLabels} collapsed={s.panels.activeCollapsed} sliding={rowSliding()} onToggleCollapse={toggleActive} />

        <div class="col waves" style={{ "grid-column": 3, "grid-row": "1 / 3" }}>
          <WavesToolbar />
          <MarkersBar />
          <div class="wv-canvas">
            <WaveCanvas />
          </div>
        </div>

        <div class="status" style={{ "grid-column": "1 / 3", "grid-row": 2 }}>
          <HoverReadout enumLabels={enumLabels} />
        </div>
      </div>

      <Show when={s.picker}>{(p) => (
        <ColorPicker
          color={s.activeSignals.find((r) => r.row === p().row)?.color ?? "#000000"}
          onChange={(c) => s.setColor(p().row, c)}
          onClose={() => s.setPicker(null)}
          anchorRect={p().anchorRect}
        />
      )}</Show>
      <Show when={s.ctxMenu}>{(m) => (
        <ContextMenu
          x={m().x}
          y={m().y}
          items={(() => {
            const ref = s.activeSignals.find((r) => r.row === m().row);
            return activeSignalMenu({
              multiBit: ref ? getSignal(SCENE.hierarchy, ref.signalId).bitWidth > 1 : false,
              clockRow: m().row,
              color: ref?.color,
            });
          })()}
          onClose={() => s.setCtxMenu(null)}
          onSelect={(it) => {
            const row = m().row;
            if (row < 0) return;
            if (it.action === "radix-bin") s.setFormat(row, "bin", undefined);
            else if (it.action === "radix-dec") s.setFormat(row, "dec", undefined);
            else if (it.action === "radix-sdec") s.setFormat(row, "sdec", undefined);
            else if (it.action === "radix-hex") s.setFormat(row, "hex", undefined);
            else if (it.action === "radix-enum") s.setFormat(row, "enum", undefined);
            else if (it.action === "format-clock") s.setFormat(row, "bin", "clock");
            else if (it.action === "format-reset") s.setFormat(row, "bin", "reset");
            else if (it.label === "Dim") s.toggleHidden(row);
            else if (it.label === "Dim Others") s.hideOthers(row);
            else if (it.label === "Remove from View") s.removeSignal(row);
            else if (it.label === "Move to Top") s.moveSignal(row, "top");
            else if (it.label === "Move to Bottom") s.moveSignal(row, "bottom");
            else if (it.label === "Change Color…") s.setPicker({ row, anchorRect: new DOMRect(m().x, m().y, 0, 0) });
          }}
          onGear={(it) => {
            const row = m().row;
            if (row < 0) return;
            if (it.action === "radix-enum") s.setEnumDialog({ row });
          }}
        />
      )}</Show>
      <Show when={s.enumDialog}>{(d) => (
        <EnumDialog row={d().row} onClose={() => s.setEnumDialog(null)} />
      )}</Show>
      <GlobalTooltip />
      <PerfOverlay />
    </div>
  );
}
