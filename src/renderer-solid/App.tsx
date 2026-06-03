import { For, Show, createSignal, createMemo, onMount } from "solid-js";
import { X, PanelLeftClose, PanelLeftOpen } from "lucide-solid";
import { useAppStore } from "./store/store";
import { WaveCanvas } from "./wave/WaveCanvas";
import { ActiveSignals } from "./ActiveSignals";
import { HoverReadout } from "./HoverReadout";
import { ColorPicker } from "./ColorPicker";
import { ContextMenu, ACTIVE_SIGNAL_MENU } from "./ContextMenu";
import { SignalTree } from "./SignalTree";
import { WavesToolbar } from "./WavesToolbar";
import { MarkersBar } from "./MarkersBar";
import { MenuBar } from "./MenuBar";
import { GlobalTooltip } from "./GlobalTooltip";
import { PerfOverlay } from "./PerfOverlay";
import { buildEnumLabels } from "./wave/value";
import { getSignal } from "../renderer/hier/hierarchy";
import { SCENE, swapTrace } from "../renderer/hier/scene";
import * as perf from "../renderer/perf";

declare const require: (m: string) => unknown;

// Ask the main process to show the Open-VCD dialog. Returns the chosen path (or
// null if cancelled); the renderer then swaps the trace in place — no reload.
async function openVcdDialog(): Promise<string | null> {
  try {
    const { ipcRenderer } = require("electron") as { ipcRenderer: { invoke(channel: string): Promise<unknown> } };
    return (await ipcRenderer.invoke("riptide:open-vcd")) as string | null;
  } catch (e) {
    console.error("[open-vcd] failed", e);
    return null;
  }
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

  // Width transition + content-slide flags: on only for the duration of a
  // collapse/expand toggle (or width reset) so live drag-resize stays instant.
  const [treeAnim, setTreeAnim] = createSignal(false);
  let treeAnimTimer: number | null = null;
  const [rowSliding, setRowSliding] = createSignal(false);
  let rowSlideTimer: number | null = null;
  const [treeToggling, setTreeToggling] = createSignal(false);
  let treeToggleTimer: number | null = null;
  const pulseLayoutAnim = () => {
    setTreeAnim(true);
    if (treeAnimTimer != null) clearTimeout(treeAnimTimer);
    treeAnimTimer = window.setTimeout(() => setTreeAnim(false), 140);
  };
  const toggleTree = (collapsed: boolean) => {
    s.setTreeCollapsed(collapsed);
    pulseLayoutAnim();
    setTreeToggling(true);
    if (treeToggleTimer != null) clearTimeout(treeToggleTimer);
    treeToggleTimer = window.setTimeout(() => setTreeToggling(false), 140);
  };
  const toggleActive = (collapsed: boolean) => {
    s.setActiveCollapsed(collapsed);
    pulseLayoutAnim();
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
    target.classList.add("dragging");
    const onMove = (ev: PointerEvent) => {
      const dx = ev.clientX - startX;
      if (which === "tree") s.setTreeWidth(Math.max(TREE_MIN_PX, startTree + dx));
      else if (which === "activeCompact") s.setActiveCompactWidth(Math.max(ACTIVE_COMPACT_MIN_PX, startCompact + dx));
      else s.setActiveWidth(Math.max(ACTIVE_MIN_PX, startActive + dx));
    };
    const onUp = (ev: PointerEvent) => {
      target.releasePointerCapture(ev.pointerId);
      target.classList.remove("dragging");
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

  return (
    <div class="app">
      <div class="titlebar">
        <div class="dots"><i class="r" /><i class="y" /><i class="g" /></div>
        <div class="title">Riptide</div>
        <MenuBar onOpenVcd={handleOpenVcd} />
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
        class={`body${treeAnim() ? " tree-anim" : ""}`}
        style={{ "grid-template-columns": `${treeColW()}px ${activeColW()}px 1fr`, "grid-template-rows": "minmax(0, 1fr) auto" }}
      >
        <Show when={!s.panels.treeCollapsed}>
          <div class="col-resize" style={{ left: `${treeColW() - 3}px` }} onPointerDown={startResize("tree")} onDblClick={() => { s.setTreeWidth(TREE_DEFAULT_PX); pulseLayoutAnim(); }} />
        </Show>
        <div
          class="col-resize"
          style={{ left: `${treeColW() + activeColW() - 3}px` }}
          onPointerDown={startResize(s.panels.activeCollapsed ? "activeCompact" : "active")}
          onDblClick={() => { if (s.panels.activeCollapsed) s.setActiveCompactWidth(null); else s.setActiveWidth(ACTIVE_DEFAULT_PX); pulseLayoutAnim(); }}
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
          items={ACTIVE_SIGNAL_MENU}
          onClose={() => s.setCtxMenu(null)}
          onSelect={(label) => { if (label === "Remove from View" && m().row >= 0) s.removeSignal(m().row); }}
        />
      )}</Show>
      <GlobalTooltip />
      <PerfOverlay />
    </div>
  );
}
