import { For } from "solid-js";
import { useAppStore } from "./store/store";
import { WaveCanvas } from "./wave/WaveCanvas";

// Phase 0 shell: the static layout chrome only, reusing the existing CSS
// (index.html). It reads the store reactively to prove hydration + fine-grained
// reactivity work end-to-end. Real panels (tree, active signals, waves canvas,
// toolbar, markers, menus) slot into these placeholders in later phases.

const MENU_NAMES = ["File", "Edit", "View", "Signals", "Markers", "Window", "Help"];

export function App() {
  const s = useAppStore();
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
            <div class="tree" />
          </div>
        </div>

        <div class="col">
          <div class="col-head">
            <h3>Active Signals</h3>
            <span class="sp" style={{ flex: 1 }} />
            <span class="hint">{s.activeSignals.length} active</span>
          </div>
          <div class="col-sub"><input class="search" placeholder="filter active signals" /></div>
          <div class="s-head"><span /><span /><span>Name</span><span>Value</span><span /></div>
          <div class="signals" />
        </div>

        <div class="col waves" style={{ "grid-column": 3, "grid-row": "1 / 3" }}>
          <div class="col-head toolbar"><span class="hint mono">waves</span></div>
          <div class="col-sub"><span class="sub-label">MARKERS</span></div>
          <div class="wv-canvas">
            <WaveCanvas />
          </div>
        </div>

        <div class="status" style={{ "grid-column": "1 / 3", "grid-row": 2 }}>
          <span class="muted st-item st-val">solid shell — phase 0</span>
        </div>
      </div>
    </div>
  );
}
