import { For, createSignal, createEffect, onCleanup } from "solid-js";
import { Portal } from "solid-js/web";
import type { MenuItem } from "./ContextMenu";

// Basename of a path (cross-platform-ish: split on both separators).
const baseName = (p: string) => p.split(/[\\/]/).pop() || p;

// Static menu definitions. File items that depend on runtime state (Open Recent)
// are injected in `menus()` below. Linux keyboard shortcuts, plain text only.
// Edit + Help are static (state-independent). Signals/View/Markers depend on
// runtime state and are built in `menus()`.
const EDIT_HELP: { name: string; items: MenuItem[] }[] = [
  { name: "Edit", items: [
    { label: "Undo", kbd: "Ctrl+Z", disabled: true, unimplemented: true }, { label: "Redo", kbd: "Ctrl+Shift+Z", disabled: true, unimplemented: true }, "sep",
    { label: "Cut", kbd: "Ctrl+X", disabled: true, unimplemented: true }, { label: "Copy", kbd: "Ctrl+C", disabled: true, unimplemented: true }, { label: "Paste", kbd: "Ctrl+V", disabled: true, unimplemented: true }, "sep", { label: "Find…", kbd: "Ctrl+F", disabled: true, unimplemented: true },
  ] },
  { name: "Help", items: [
    { label: "Documentation", disabled: true, unimplemented: true },
    { label: "Keyboard Shortcuts", kbd: "Ctrl+/", disabled: true, unimplemented: true },
    "sep",
    { label: "About Riptide", disabled: true, unimplemented: true },
  ] },
];

export function MenuBar(props: {
  // No trace loaded: disable everything except File ▸ Open / Open Recent / Close.
  idle: () => boolean;
  onOpenVcd: () => void;
  onOpenRecent: (path: string) => void;
  onExportSidecar: () => void;
  getRecent: () => Promise<string[]>;
  onCloseWindow: () => void;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onZoomFit: () => void;
  treeCollapsed: () => boolean;
  onToggleTree: (collapsed: boolean) => void;
  activeCollapsed: () => boolean;
  onToggleActive: (collapsed: boolean) => void;
  snapOn: () => boolean;
  onToggleSnap: () => void;
  clockOn: () => boolean;
  onToggleClock: () => void;
  markerCount: () => number;
  markerSelected: () => boolean;
  onMarkerAdd: () => void;
  onMarkerDelete: () => void;
  onMarkerClear: () => void;
  onMarkerNext: () => void;
  onMarkerPrev: () => void;
  // Signals menu operates on the currently selected active-signal row.
  signalSelected: () => boolean;
  signalHidden: () => boolean;
  onSignalHide: () => void;
  onSignalColor: () => void;
  onSignalMoveTop: () => void;
  onSignalMoveBottom: () => void;
  onSignalRemove: () => void;
}) {
  const [open, setOpen] = createSignal<{ name: string; rect: DOMRect } | null>(null);
  // Frozen snapshot of the last-open menu — stays mounted while `open` is null so
  // the popup can fade out.
  const [pop, setPop] = createSignal<{ rect: DOMRect; items: MenuItem[] } | null>(null);
  // Second-tier submenu (e.g. Open Recent), and its frozen snapshot for the fade.
  const [sub, setSub] = createSignal<{ rect: DOMRect; items: MenuItem[] } | null>(null);
  const [subPop, setSubPop] = createSignal<{ rect: DOMRect; items: MenuItem[] } | null>(null);
  const [recent, setRecent] = createSignal<string[]>([]);

  const recentSubmenu = (): MenuItem[] =>
    recent().length === 0
      ? [{ label: "No Recent Traces", disabled: true }]
      : recent().map((p) => ({ label: baseName(p), action: "open-recent", path: p }));

  const menus = (): { name: string; items: MenuItem[] }[] => {
    // Idle (no trace): only File ▸ Open / Open Recent / Close Window stay live;
    // everything that operates on a loaded trace is disabled.
    const idle = props.idle();
    return [
    { name: "File", items: [
      { label: "New Window", kbd: "Ctrl+N", disabled: true, unimplemented: true },
      { label: "Open VCD…", kbd: "Ctrl+O", action: "open-vcd" },
      { label: "Open Recent", submenu: recentSubmenu() },
      "sep",
      { label: "Export Sidecar…", action: "export-sidecar", disabled: idle },
      "sep",
      { label: "Reload Trace", kbd: "Ctrl+R", disabled: true, unimplemented: true },
      "sep",
      { label: "Close Window", kbd: "Ctrl+W", action: "close-window" },
    ] },
    EDIT_HELP[0], // Edit
    { name: "View", items: [
      { label: "Zoom In", kbd: "Ctrl+=", action: "zoom-in", disabled: idle },
      { label: "Zoom Out", kbd: "Ctrl+-", action: "zoom-out", disabled: idle },
      { label: "Zoom to Fit", kbd: "Ctrl+0", action: "zoom-fit", disabled: idle },
      "sep",
      { label: props.treeCollapsed() ? "Expand Signal Tree" : "Collapse Signal Tree", action: "toggle-tree", disabled: idle },
      { label: props.activeCollapsed() ? "Expand Active Signals" : "Compact Active Signals", action: "toggle-active", disabled: idle },
      "sep",
      { label: "Grid Snap", checked: props.snapOn(), action: "toggle-snap", disabled: idle },
      { label: "Align Grid to Clock", checked: props.clockOn(), action: "toggle-clock", disabled: idle },
      "sep",
      { label: "Reset Layout", disabled: true, unimplemented: true },
    ] },
    { name: "Signals", items: [
      { label: props.signalHidden() ? "Show Signal" : "Hide Signal", action: "signal-hide", disabled: idle || !props.signalSelected() },
      { label: "Change Color…", action: "signal-color", disabled: idle || !props.signalSelected() },
      "sep",
      { label: "Move to Top", action: "signal-top", disabled: idle || !props.signalSelected() },
      { label: "Move to Bottom", action: "signal-bottom", disabled: idle || !props.signalSelected() },
      "sep",
      { label: "Remove from View", action: "signal-remove", disabled: idle || !props.signalSelected() },
    ] },
    { name: "Markers", items: [
      { label: "Add Marker at Cursor", kbd: "M", action: "marker-add", disabled: idle },
      { label: "Delete Marker", kbd: "Backspace", action: "marker-delete", disabled: idle || !props.markerSelected() },
      { label: "Clear All Markers", action: "marker-clear", disabled: idle || props.markerCount() === 0 },
      "sep",
      { label: "Next Marker", kbd: "]", action: "marker-next", disabled: idle || props.markerCount() === 0 },
      { label: "Previous Marker", kbd: "[", action: "marker-prev", disabled: idle || props.markerCount() === 0 },
    ] },
    EDIT_HELP[1], // Help
    ];
  };

  createEffect(() => {
    const o = open();
    if (!o) return;
    const menu = menus().find((m) => m.name === o.name);
    if (menu) setPop({ rect: o.rect, items: menu.items });
  });
  // Refresh the recent list whenever the File menu opens.
  createEffect(() => {
    if (open()?.name === "File") props.getRecent().then(setRecent);
  });
  createEffect(() => {
    const s = sub();
    if (s) setSubPop(s);
  });
  createEffect(() => {
    if (!open()) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as HTMLElement;
      if (!t.closest(".menubar") && !t.closest(".menu-pop")) setOpen(null);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(null); };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    onCleanup(() => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    });
  });
  // Closing the top menu collapses any open submenu.
  createEffect(() => { if (!open()) setSub(null); });

  const activate = (it: Exclude<MenuItem, "sep">) => {
    if (it.disabled || it.submenu) return;
    setOpen(null);
    if (it.action === "open-vcd") props.onOpenVcd();
    else if (it.action === "open-recent" && it.path) props.onOpenRecent(it.path);
    else if (it.action === "export-sidecar") props.onExportSidecar();
    else if (it.action === "close-window") props.onCloseWindow();
    else if (it.action === "zoom-in") props.onZoomIn();
    else if (it.action === "zoom-out") props.onZoomOut();
    else if (it.action === "zoom-fit") props.onZoomFit();
    else if (it.action === "toggle-tree") props.onToggleTree(!props.treeCollapsed());
    else if (it.action === "toggle-active") props.onToggleActive(!props.activeCollapsed());
    else if (it.action === "toggle-snap") props.onToggleSnap();
    else if (it.action === "toggle-clock") props.onToggleClock();
    else if (it.action === "marker-add") props.onMarkerAdd();
    else if (it.action === "marker-delete") props.onMarkerDelete();
    else if (it.action === "marker-clear") props.onMarkerClear();
    else if (it.action === "marker-next") props.onMarkerNext();
    else if (it.action === "marker-prev") props.onMarkerPrev();
    else if (it.action === "signal-hide") props.onSignalHide();
    else if (it.action === "signal-color") props.onSignalColor();
    else if (it.action === "signal-top") props.onSignalMoveTop();
    else if (it.action === "signal-bottom") props.onSignalMoveBottom();
    else if (it.action === "signal-remove") props.onSignalRemove();
  };

  const renderItem = (it: MenuItem, isSub: boolean) =>
    it === "sep" ? <div class="menu-sep" /> : (
      <div
        class={`menu-item${it.disabled ? " disabled" : ""}${it.unimplemented ? " unimplemented" : ""}${!isSub && it.submenu && sub() ? " active" : ""}`}
        onClick={() => activate(it)}
        onMouseEnter={(e) => {
          if (isSub) return;
          if (it.submenu) setSub({ rect: e.currentTarget.getBoundingClientRect(), items: it.submenu });
          else setSub(null);
        }}
      >
        <span>{it.label}</span>
        {it.submenu ? <span class="menu-arrow">›</span>
          : it.checked !== undefined ? <span class="menu-check">{it.checked ? "✓" : ""}</span>
          : it.kbd ? <span class="menu-kbd">{it.kbd}</span> : null}
      </div>
    );

  return (
    <div class="menubar">
      <For each={menus()}>{(m) => (
        <span
          class={`m${open()?.name === m.name ? " open" : ""}`}
          onClick={(e) => {
            const rect = e.currentTarget.getBoundingClientRect();
            setOpen((o) => (o?.name === m.name ? null : { name: m.name, rect }));
          }}
          onMouseEnter={(e) => { if (open()) setOpen({ name: m.name, rect: e.currentTarget.getBoundingClientRect() }); }}
        >{m.name}</span>
      )}</For>
      <Portal>
        <div
          class={`menu-pop${open() ? " show" : ""}`}
          style={{ left: `${pop()?.rect.left ?? 0}px`, top: `${(pop()?.rect.bottom ?? 0) + 4}px` }}
        >
          <For each={pop()?.items ?? []}>{(it) => renderItem(it, false)}</For>
        </div>
        <div
          class={`menu-pop${open() && sub() ? " show" : ""}`}
          style={{ left: `${(subPop()?.rect.right ?? 0) - 4}px`, top: `${(subPop()?.rect.top ?? 0) - 6}px` }}
        >
          <For each={subPop()?.items ?? []}>{(it) => renderItem(it, true)}</For>
        </div>
      </Portal>
    </div>
  );
}
