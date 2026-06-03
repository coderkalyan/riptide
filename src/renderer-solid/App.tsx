import { For, Show, createMemo } from "solid-js";
import { useAppStore } from "./store/store";
import { WaveCanvas } from "./wave/WaveCanvas";
import { ActiveSignals } from "./ActiveSignals";
import { HoverReadout } from "./HoverReadout";
import { ColorPicker } from "./ColorPicker";
import { ContextMenu, ACTIVE_SIGNAL_MENU } from "./ContextMenu";
import { SignalTree } from "./SignalTree";
import { buildEnumLabels } from "./wave/value";

// App shell: static layout chrome (titlebar/menus/tabs, three-column body) plus
// the real Active Signals panel + hover readout + canvas. Tree, toolbar, markers
// bar, and the menus/tooltips/panel-collapse chrome slot in in later phases.

const MENU_NAMES = ["File", "Edit", "View", "Signals", "Markers", "Window", "Help"];

export function App() {
  const s = useAppStore();
  // Shared per-row enum label maps — feeds the value column + hover readout.
  const enumLabels = createMemo(() => buildEnumLabels(s.activeSignals));
  const treeColW = () => (s.panels.treeCollapsed ? 28 : s.panels.treeWidth);
  const activeColW = () => (s.panels.activeCollapsed ? (s.panels.activeCompactWidth ?? 88) : s.panels.activeWidth);

  return (
    <div class="app">
      <div class="titlebar">
        <div class="dots"><i class="r" /><i class="y" /><i class="g" /></div>
        <div class="title">Riptide</div>
        <div class="menubar">
          <For each={MENU_NAMES}>{(name) => <span class="m">{name}</span>}</For>
        </div>
        <div class="divider" />
        <div class="tabs">
          <For each={s.tabs.open}>{(f, i) => (
            <span class={`tab${i() === s.tabs.active ? " active" : ""}`} onClick={() => s.setActiveTab(i())}>{f}</span>
          )}</For>
        </div>
        <div class="sp" />
      </div>

      <div class="body" style={{ "grid-template-columns": `${treeColW()}px ${activeColW()}px 1fr`, "grid-template-rows": "minmax(0, 1fr) auto" }}>
        <div class="col">
          <div class="col-inner">
            <div class="col-head"><h3>Signal Tree</h3><span class="sp" style={{ flex: 1 }} /></div>
            <div class="col-sub"><input class="search" placeholder="filter scope/name" /></div>
            <SignalTree />
          </div>
        </div>

        <ActiveSignals enumLabels={enumLabels} />

        <div class="col waves" style={{ "grid-column": 3, "grid-row": "1 / 3" }}>
          <div class="col-head toolbar"><span class="hint mono">waves</span></div>
          <div class="col-sub"><span class="sub-label">MARKERS</span></div>
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
    </div>
  );
}
