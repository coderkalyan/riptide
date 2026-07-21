import { For, Show, createSignal, createMemo, createEffect, onMount, onCleanup } from "solid-js";
import { PanelLeftClose, PanelLeftOpen, FileText, FolderOpen, RotateCw, Minus, Square, Copy, X } from "lucide-solid";
import { useAppStore, selectExportSidecarText, flushAutosave } from "./store/store";
import { WaveCanvas } from "./wave/WaveCanvas";
import { ActiveSignals } from "./ActiveSignals";
import { HoverReadout } from "./HoverReadout";
import { ColorPicker } from "./ColorPicker";
import { ContextMenu, activeSignalMenu, dividerMenu, paneMenu, treeMenu } from "./ContextMenu";
import { EnumDialog } from "./EnumDialog";
import { AboutDialog } from "./AboutDialog";
import { SignalTree, resolveAddIds, recursiveSigChildren, allScopeIds } from "./SignalTree";
import { WavesToolbar } from "./WavesToolbar";
import { MarkersBar } from "./MarkersBar";
import { MenuBar } from "./MenuBar";
import { buildMenus, type MenuState } from "./menuModel";
import { GlobalTooltip } from "./GlobalTooltip";
import { PerfOverlay } from "./PerfOverlay";
import { buildEnumLabels } from "./wave/value";
import { getSignal } from "./hier/hierarchy";
import { SCENE, swapTrace, applySidecar, currentVcdPath, hasTrace } from "./hier/scene";
import { view } from "./wave/viewport";
import { ZOOM_STEP } from "./wave/constants";
import * as perf from "./perf";

declare const require: (m: string) => unknown;

// Ask the main process to show the Open-VCD dialog. Returns the chosen path (or
// null if cancelled); the renderer then swaps the trace in place — no reload.
type IpcRenderer = {
  invoke(channel: string, ...args: unknown[]): Promise<unknown>;
  send(channel: string, ...args: unknown[]): void;
  on(channel: string, listener: (e: unknown, ...args: unknown[]) => void): void;
  removeListener(channel: string, listener: (e: unknown, ...args: unknown[]) => void): void;
};
function ipc(): IpcRenderer | null {
  try {
    return (require("electron") as { ipcRenderer: IpcRenderer }).ipcRenderer;
  } catch (e) {
    console.error("[ipc] unavailable", e);
    return null;
  }
}

async function openVcdDialog(): Promise<string | null> {
  return ((await ipc()?.invoke("riptide:open-vcd")) as string | null) ?? null;
}

// Window-chrome config from the URL (set by the main process). On Linux "custom"
// frame the window is frameless and the app draws its own controls; `chrome` is
// absent on native-frame Linux and all other platforms (WM/OS owns the frame).
const CHROME_CUSTOM = new URLSearchParams(location.search).get("chrome") === "custom";
const IS_LINUX = (() => {
  try { return (require("os") as { platform(): string }).platform() === "linux"; } catch { return false; }
})();
// macOS uses the native window frame + the system menu bar (built in the main process
// from the shared menuModel). The custom in-app titlebar/menu is hidden there.
const IS_MAC = (() => {
  try { return (require("os") as { platform(): string }).platform() === "darwin"; } catch { return false; }
})();

// Frameless-Linux window controls, sitting where the title-bar dots were. Styled as
// dots (like the old traffic-light placeholder) but neutral — no mac-style
// red/yellow/green — with the glyph always shown. Order: close, maximize, minimize.
function WindowControls(props: { maximized: () => boolean; onMin: () => void; onMax: () => void; onClose: () => void }) {
  return (
    <div class="win-controls">
      <button class="wc close" data-tip="close" onClick={props.onClose}><X size={9} /></button>
      <button class="wc" data-tip={props.maximized() ? "restore" : "maximize"} onClick={props.onMax}>
        {props.maximized() ? <Copy size={8} /> : <Square size={7} />}
      </button>
      <button class="wc" data-tip="minimize" onClick={props.onMin}><Minus size={9} /></button>
    </div>
  );
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
    flushAutosave(); // pending debounced write must land in the OLD sidecar
    perf.beginSwap();
    swapTrace(p);
    s.resetForTrace();
  };

  // Open a recent trace: note it as opened (bumps the recent list main-side),
  // then swap in place — same path as handleOpenVcd minus the dialog.
  const handleOpenRecent = async (p: string) => {
    await ipc()?.invoke("riptide:open-recent", p);
    flushAutosave();
    perf.beginSwap();
    swapTrace(p);
    s.resetForTrace();
  };

  // Reload the trace currently open from disk — same in-place swap as Open, but
  // re-reads the same path (used by the titlebar refresh button + after the file
  // watcher flags a change). resetForTrace clears traceStale via freshUi.
  const handleReload = () => {
    const p = currentVcdPath();
    if (!p) return;
    flushAutosave(); // swap re-hydrates from the on-disk sidecar — don't lose a pending write
    perf.beginSwap();
    swapTrace(p);
    s.resetForTrace();
  };

  // Watch the open trace on disk (chokidar). On change we do NOT auto-reload —
  // that would clobber the view mid-inspection — we set traceStale so the pill
  // lights up warm and the user reloads on click. Re-armed on every trace swap
  // (traceNonce) so it follows Open VCD…/reload to the new path. ignoreInitial +
  // awaitWriteFinish avoid firing on our own load or on a simulator's partial
  // mid-write flushes.
  onMount(() => {
    let watcher: { close(): Promise<void> | void } | null = null;
    createEffect(() => {
      s.traceNonce; // re-arm the watch whenever the trace (re)loads
      const p = currentVcdPath();
      watcher?.close();
      watcher = null;
      if (!p) return;
      try {
        // chokidar 5's FSWatcher event-map typing trips tsc on .on(); we only
        // need watch/on/close, so type it minimally.
        const chokidar = require("chokidar") as {
          watch(path: string, opts?: unknown): { on(ev: string, cb: () => void): unknown; close(): Promise<void> | void };
        };
        const w = chokidar.watch(p, { ignoreInitial: true, awaitWriteFinish: { stabilityThreshold: 150, pollInterval: 50 } });
        w.on("change", () => useAppStore.getState().setTraceStale(true));
        watcher = w;
      } catch (e) {
        console.error("[watch] chokidar unavailable", e);
      }
    });
    onCleanup(() => { watcher?.close(); });
  });

  // Export the current view as a portable, UI-chrome-stripped sidecar via a
  // native save dialog (main writes the file).
  const handleExportSidecar = async () => {
    const text = selectExportSidecarText(useAppStore.getState());
    await ipc()?.invoke("riptide:export-sidecar", text);
  };

  // Import a sidecar against the open trace (no VCD reload): the main process
  // returns the chosen path, scene.applySidecar loads/validates/re-resolves it,
  // then resetForTrace re-seeds the store + repacks — same in-place flow as Open.
  const handleImportSidecar = async () => {
    const p = (await ipc()?.invoke("riptide:import-sidecar")) as string | null;
    if (!p) return;
    perf.beginSwap();
    if (!applySidecar(p)) { console.error("[import] invalid or unreadable sidecar", p); return; }
    s.resetForTrace();
  };

  const getRecent = async () => ((await ipc()?.invoke("riptide:recent-vcds")) as string[] | null) ?? [];
  const closeWindow = () => { ipc()?.invoke("riptide:close-window"); };
  const minimizeWindow = () => { ipc()?.invoke("riptide:minimize-window"); };
  const toggleMaximize = () => { ipc()?.invoke("riptide:toggle-maximize"); };
  // Track real maximize state so the control swaps maximize <-> restore. Seed from
  // the current state, then follow main's push events (the WM can (un)maximize too).
  const [maximized, setMaximized] = createSignal(false);
  const [showAbout, setShowAbout] = createSignal(false);
  onMount(() => {
    if (!CHROME_CUSTOM) return;
    ipc()?.invoke("riptide:is-maximized").then((v) => setMaximized(!!v));
    try {
      const { ipcRenderer } = require("electron") as { ipcRenderer: { on(c: string, l: (e: unknown, v: boolean) => void): void; removeListener(c: string, l: (e: unknown, v: boolean) => void): void } };
      const on = (_e: unknown, v: boolean) => setMaximized(!!v);
      ipcRenderer.on("riptide:maximized", on);
      onCleanup(() => ipcRenderer.removeListener("riptide:maximized", on));
    } catch (e) { console.error("[ipc] maximize subscribe failed", e); }
  });
  // Flip Linux frame style; main persists it and recreates the window.
  const toggleFrame = () => { ipc()?.invoke("riptide:set-frame-style", CHROME_CUSTOM ? "native" : "custom"); };

  const zoomIn = () => view.zoomBy(1 / ZOOM_STEP);
  const zoomOut = () => view.zoomBy(ZOOM_STEP);
  const zoomFit = () => view.fitView();

  const deleteSelMarker = () => { if (s.selectedMarkerId != null) s.deleteMarker(s.selectedMarkerId); };

  // Signals menu: operate on the selected active-signal row (mirrors the row's
  // right-click menu). Color anchors to the selected row's pin swatch so Coloris
  // opens in the same spot as clicking the pin directly.
  const selSignal = () => s.activeSignals.find((r) => r.selected);
  // Currently-open trace, shown in the titlebar pill (where tabs will eventually go).
  // currentVcdPath() is the real source of truth (set by swapTrace); traceNonce makes
  // this re-read on an in-app Open. basename only — full path lives in the tooltip.
  const openFile = createMemo(() => { s.traceNonce; return currentVcdPath().split(/[\\/]/).pop() || "untitled"; });
  // Whether a trace is loaded — gates the whole working UI. When idle (no file)
  // only the menu bar + an open-file prompt show. traceNonce makes this re-read
  // after an in-app Open (swapTrace sets currentVcdPath, resetForTrace bumps it).
  const traceOpen = createMemo(() => { s.traceNonce; return hasTrace(); });
  const onSignalColor = () => {
    const r = selSignal();
    if (!r) return;
    const pin = document.querySelector(".s-row.sel .pin");
    const rect = pin ? pin.getBoundingClientRect() : new DOMRect(220, 90, 0, 0);
    s.setPicker({ row: r.row, anchorRect: rect });
  };

  // Menu state snapshot (labels + enabled/checked flags), shared by the in-app MenuBar
  // and the native macOS menu (see menuModel). Reactive: re-derives on any store change.
  const menuState = createMemo<MenuState>(() => ({
    idle: !traceOpen(),
    treeCollapsed: s.panels.treeCollapsed,
    activeCollapsed: s.panels.activeCollapsed,
    snapOn: s.snapCursor,
    clockOn: s.clockAnchor,
    clockAvailable: s.clockAnchor || s.timebaseClock != null || s.activeSignals.some((r) => r.role === "clock"),
    markerCount: s.markers.length,
    markerSelected: s.selectedMarkerId != null,
    signalSelected: s.activeSignals.some((r) => r.selected),
    signalHidden: selSignal()?.hidden ?? false,
    linux: IS_LINUX,
    frameStyle: CHROME_CUSTOM ? "custom" : "native",
  }));

  // Single dispatch for a menu action string — both the in-app MenuBar and native
  // macOS menu clicks route here (keeps the action→handler mapping in one place).
  const runMenuAction = (action: string, path?: string) => {
    switch (action) {
      case "open-vcd": handleOpenVcd(); break;
      case "open-recent": if (path) handleOpenRecent(path); break;
      case "reload-trace": handleReload(); break;
      case "import-sidecar": handleImportSidecar(); break;
      case "export-sidecar": handleExportSidecar(); break;
      case "close-window": closeWindow(); break;
      case "toggle-frame": toggleFrame(); break;
      case "zoom-in": zoomIn(); break;
      case "zoom-out": zoomOut(); break;
      case "zoom-fit": zoomFit(); break;
      case "toggle-tree": toggleTree(!s.panels.treeCollapsed); break;
      case "toggle-active": toggleActive(!s.panels.activeCollapsed); break;
      case "toggle-snap": s.toggleSnap(); break;
      case "toggle-clock": s.toggleClock(); break;
      case "marker-add": s.addMarkerAtCursor(); break;
      case "marker-delete": deleteSelMarker(); break;
      case "marker-clear": s.clearMarkers(); break;
      case "marker-next": s.cycleMarker(1); break;
      case "marker-prev": s.cycleMarker(-1); break;
      case "signal-hide": { const r = selSignal(); if (r) s.toggleHidden(r.row); break; }
      case "signal-color": onSignalColor(); break;
      case "signal-top": { const r = selSignal(); if (r) s.moveSignal(r.row, "top"); break; }
      case "signal-bottom": { const r = selSignal(); if (r) s.moveSignal(r.row, "bottom"); break; }
      case "signal-remove": { const r = selSignal(); if (r) s.removeSignal(r.row); break; }
      case "about": setShowAbout(true); break;
    }
  };

  // macOS native menu: the app menu lives in the main process. Push the shared menu
  // tree whenever state/recent changes (main renders it), and route native menu clicks
  // back through runMenuAction. Recent is main-owned, so re-fetch after each trace swap.
  const [macRecent, setMacRecent] = createSignal<string[]>([]);
  onMount(() => {
    if (!IS_MAC) return;
    const r = ipc();
    const on = (_e: unknown, msg: unknown) => {
      const m = msg as { action: string; path?: string };
      runMenuAction(m.action, m.path);
    };
    r?.on("riptide:menu-action", on);
    onCleanup(() => r?.removeListener("riptide:menu-action", on));
  });
  createEffect(() => {
    if (!IS_MAC) return;
    s.traceNonce; // re-fetch recent after any open/reload (opens bump the list)
    getRecent().then(setMacRecent);
  });
  createEffect(() => {
    if (!IS_MAC) return;
    ipc()?.send("riptide:menu-descriptor", buildMenus(menuState(), macRecent()));
  });

  // Global keyboard shortcuts mirroring the File/View menus.
  onMount(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.ctrlKey || e.altKey) return;
      const k = e.key.toLowerCase();
      if (!e.shiftKey && k === "o") { e.preventDefault(); handleOpenVcd(); }
      else if (!e.shiftKey && k === "r") { e.preventDefault(); handleReload(); }
      // Zoom shortcuts only matter with a trace open (the canvas is unmounted when
      // idle). Ctrl+= / Ctrl++ zoom in, Ctrl+- zoom out, Ctrl+0 fit. "=" is the
      // unshifted "+" key, so accept both; the numpad sends "Add"/"Subtract".
      else if (!traceOpen()) return;
      else if (k === "=" || k === "+") { e.preventDefault(); zoomIn(); }
      else if (k === "-" || k === "_") { e.preventDefault(); zoomOut(); }
      else if (k === "0") { e.preventDefault(); zoomFit(); }
    };
    document.addEventListener("keydown", onKey);
    onCleanup(() => document.removeEventListener("keydown", onKey));
  });

  return (
    <div class="app">
      {/* macOS hides the custom titlebar entirely: the native window frame owns the
          window controls + title, and the menu lives in the system menu bar (built in
          the main process from the shared menuModel). Linux/Windows draw it in-app. */}
      <Show when={!IS_MAC}>
      <div class={`titlebar${CHROME_CUSTOM ? " draggable" : ""}`}>
        {/* Left slot (where the dots sat): custom window controls on frameless
            Linux, else the Windows decorative dots. Native-frame Linux shows
            neither — the WM draws the frame. */}
        <Show when={CHROME_CUSTOM}>
          <WindowControls maximized={maximized} onMin={minimizeWindow} onMax={toggleMaximize} onClose={closeWindow} />
        </Show>
        <Show when={!IS_LINUX}>
          <div class="dots"><i class="r" /><i class="y" /><i class="g" /></div>
        </Show>
        <div class="title">Riptide</div>
        <MenuBar state={menuState} onAction={runMenuAction} getRecent={getRecent} />
        {/* Pill noting the open file (multi-file tabs aren't built). Hidden while
            idle. The whole pill is the reload button (re-reads the file in place);
            goes warm (.stale) when the watcher sees an on-disk change. On macOS the
            reload lives in File ▸ Reload File instead (no titlebar). */}
        <Show when={traceOpen()}>
          <span
            class={`pill file reloadable${s.traceStale ? " stale" : ""}`}
            data-tip={s.traceStale ? "file changed on disk — click to reload" : `reload ${currentVcdPath()}`}
            onClick={handleReload}
          >
            <RotateCw size={12} />
            <span class="mono">{openFile()}</span>
          </span>
        </Show>
        <div class="sp" />
      </div>
      </Show>

      <Show
        when={traceOpen()}
        fallback={
          <div class="empty-state">
            <FileText size={46} stroke-width={1} class="es-icon" />
            <h2>No waveform open</h2>
            <p>Open a VCD file to view its signals.</p>
            <button class="es-open" onClick={handleOpenVcd}><FolderOpen size={15} /> Open VCD…</button>
            <span class="es-hint">or press <kbd>Ctrl</kbd>+<kbd>O</kbd></span>
          </div>
        }
      >
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
                <div class="col-head tw:pr-[3px]">
                  <h3>Signal Tree</h3>
                  <span class="sp" />
                  <Show when={s.treeSelection.length > 0}>
                    <span class="hint">{resolveAddIds(s.treeSelection).length} selected</span>
                    <span class="collapse" data-tip="clear selection" onClick={() => s.clearTreeSelection()}>×</span>
                  </Show>
                  <span class="collapse" data-tip="collapse panel" onClick={() => toggleTree(true)}><PanelLeftClose size={14} stroke-width={1.75} /></span>
                </div>
                {/* Filtering isn't wired up yet — disabled so it doesn't read as a working control. */}
                <div class="col-sub"><input class="search" placeholder="filter scope/name" disabled data-tip="filtering not yet implemented" /></div>
                <SignalTree />
              </div>
            }
          >
            <div class="col-head tw:justify-center">
              <span class="collapse" data-tip="expand panel" onClick={() => toggleTree(false)}><PanelLeftOpen size={14} stroke-width={1.75} /></span>
            </div>
            <div class="col-vtitle">Signal Tree</div>
          </Show>
        </div>

        <ActiveSignals enumLabels={enumLabels} collapsed={s.panels.activeCollapsed} sliding={rowSliding()} onToggleCollapse={toggleActive} />

        <div class="col waves tw:col-start-3 tw:row-start-1 tw:row-end-3">
          <WavesToolbar />
          <MarkersBar />
          <div class="wv-canvas">
            <WaveCanvas />
          </div>
        </div>

        <div class="status tw:col-start-1 tw:col-end-3 tw:row-start-2">
          <HoverReadout enumLabels={enumLabels} />
        </div>
      </div>

      <Show when={s.picker}>{(p) => (
        <ColorPicker
          color={s.activeSignals.find((r) => r.row === p().row)?.color ?? "#000000"}
          onChange={(c) => (p().rows ?? [p().row]).forEach((r) => s.setColor(r, c))}
          onClose={() => s.setPicker(null)}
          anchorRect={p().anchorRect}
        />
      )}</Show>
      <Show when={s.ctxMenu}>{(m) => {
        const bitWidthOf = (row: number) => {
          const ref = s.activeSignals.find((r) => r.row === row);
          return ref ? getSignal(SCENE.hierarchy, ref.signalId).bitWidth : 0;
        };
        // Menu target = the whole selection if any rows are selected, else the
        // right-clicked row. `primary` (the clicked row if it's a target, else the
        // first) drives single-row display bits: format check, color, clock config.
        const menuTargets = () => {
          // Live read: this runs from event handlers (onSelect/onGear), where the
          // reactive `s` proxy can lag the store (see CLAUDE.md handler convention).
          const active = useAppStore.getState().activeSignals;
          const clicked = m().row;
          // Right-click inside the selection → act on the whole selection. Outside it
          // (or nothing selected) → act on just the clicked row (it's only highlighted
          // transiently, not added to the selection).
          const inSel = active.find((r) => r.row === clicked)?.selected ?? false;
          const rows = inSel ? active.filter((r) => r.selected).map((r) => r.row) : (clicked >= 0 ? [clicked] : []);
          const primary = rows.includes(clicked) ? clicked : (rows[0] ?? -1);
          return { rows, primary };
        };
        return (
        <ContextMenu
          x={m().x}
          y={m().y}
          items={(() => {
            if (m().kind === "divider") return dividerMenu();
            if (m().kind === "pane") return paneMenu();
            if (m().kind === "tree") {
              const nid = m().nodeId;
              const isScope = nid != null && SCENE.hierarchy.nodes.get(nid)?.kind === "scope";
              return treeMenu({ isScope: !!isScope, addCount: resolveAddIds(useAppStore.getState().treeSelection).length });
            }
            const t = menuTargets();
            const active = s.activeSignals;
            const ref = active.find((r) => r.row === t.primary);
            const widths = t.rows.map((r) => bitWidthOf(r));
            // Swatch only when every target shares one color; non-uniform → omit it.
            const colors = new Set(t.rows.map((r) => active.find((x) => x.row === r)?.color));
            // Mute candidates: every 1-bit active signal except the target rows
            // (a row can't mute itself). The mute is uniform only if all targets
            // share it; clocks can't be muted (native ignores it for clk kind).
            const targetRows = new Set(t.rows);
            const muteOptions = active
              .filter((x) => !targetRows.has(x.row) && getSignal(SCENE.hierarchy, x.signalId).bitWidth === 1)
              .map((x) => ({ path: x.path, name: getSignal(SCENE.hierarchy, x.signalId).name }));
            const mutes = t.rows.map((r) => active.find((x) => x.row === r)?.mute);
            const uniqMutes = new Set(mutes);
            return activeSignalMenu({
              anyMultiBit: widths.some((w) => w > 1),
              anySingleBit: widths.some((w) => w === 1),
              clockRow: t.primary,
              color: colors.size === 1 ? [...colors][0] : undefined,
              currentFormat: ref
                ? ref.role === "clock" ? "format-clock"
                  : ref.role === "reset" ? "format-reset"
                  : `radix-${ref.radix}`
                : undefined,
              muteOptions,
              currentMute: uniqMutes.size === 1 ? [...uniqMutes][0] : undefined,
              muteNone: mutes.every((m) => !m),
              anyMutable: t.rows.some((r) => active.find((x) => x.row === r)?.role !== "clock"),
            });
          })()}
          onClose={() => s.setCtxMenu(null)}
          onSelect={(it) => {
            // Signal-tree menu actions act on the tree selection / right-clicked node.
            if (m().kind === "tree") {
              const sel = useAppStore.getState().treeSelection;
              const nid = m().nodeId;
              if (it.action === "tree-add") s.addSignals(resolveAddIds(sel));
              else if (it.action === "tree-add-recursive" && nid != null) s.addSignals(recursiveSigChildren(nid));
              else if (it.action === "tree-expand-all") s.setExpanded(allScopeIds());
              else if (it.action === "tree-collapse-all") s.setExpanded([]);
              else if (it.action === "tree-select-scope" && nid != null) s.setTreeSelection(recursiveSigChildren(nid));
              return;
            }
            // Divider insert/remove acts positionally on the right-clicked row /
            // divider (NOT the whole multi-selection — placement would be ambiguous).
            if (it.action === "add-divider-above") { if (m().row >= 0) s.addDividerAbove(m().row); return; }
            if (it.action === "add-divider-below") { if (m().row >= 0) s.addDividerBelow(m().row); return; }
            if (it.action === "remove-divider") { const d = m().div; if (d) s.removeDivider(d); return; }
            if (it.action === "add-divider-bottom") { s.addDividerBottom(); return; }
            const { rows, primary } = menuTargets();
            if (rows.length === 0) return;
            // Binary/Signed Decimal are enabled if ANY target fits; apply only to
            // the fitting subset (1-bit / multi-bit respectively).
            const single = rows.filter((r) => bitWidthOf(r) === 1);
            const multi = rows.filter((r) => bitWidthOf(r) > 1);
            if (it.action === "radix-bin") single.forEach((r) => s.setFormat(r, "bin", undefined));
            else if (it.action === "radix-boolean") rows.forEach((r) => s.setFormat(r, "boolean", undefined));
            else if (it.action === "radix-dec") rows.forEach((r) => s.setFormat(r, "dec", undefined));
            else if (it.action === "radix-sdec") multi.forEach((r) => s.setFormat(r, "sdec", undefined));
            else if (it.action === "radix-hex") rows.forEach((r) => s.setFormat(r, "hex", undefined));
            else if (it.action === "radix-enum") rows.forEach((r) => s.setFormat(r, "enum", undefined));
            // Clock/Reset are 1-bit roles — apply only to the single-bit subset.
            else if (it.action === "format-clock") single.forEach((r) => s.setFormat(r, "bin", "clock"));
            else if (it.action === "format-reset") single.forEach((r) => s.setFormat(r, "bin", "reset"));
            // Mute applies only to non-clock targets (it.path undefined = clear).
            else if (it.action === "set-mute") {
              const a = useAppStore.getState().activeSignals;
              s.setMute(rows.filter((r) => a.find((x) => x.row === r)?.role !== "clock"), it.path);
            }
            else if (it.label === "Dim") rows.forEach((r) => s.toggleHidden(r));
            else if (it.label === "Dim Others") s.hideExcept(rows);
            else if (it.label === "Remove from View") s.removeSignals(rows);
            else if (it.label === "Move to Top") s.moveSignals(rows, "top");
            else if (it.label === "Move to Bottom") s.moveSignals(rows, "bottom");
            else if (it.label === "Change Color…") s.setPicker({ row: primary, rows, anchorRect: new DOMRect(m().x, m().y, 0, 0) });
          }}
          onGear={(it) => {
            const { primary } = menuTargets();
            if (primary < 0) return;
            if (it.action === "radix-enum") s.setEnumDialog({ row: primary });
          }}
        />
        );
      }}</Show>
      <Show when={s.enumDialog}>{(d) => (
        <EnumDialog row={d().row} onClose={() => s.setEnumDialog(null)} />
      )}</Show>
      <Show when={showAbout()}>
        <AboutDialog onClose={() => setShowAbout(false)} />
      </Show>
      </Show>
      <GlobalTooltip />
      <PerfOverlay />
    </div>
  );
}
