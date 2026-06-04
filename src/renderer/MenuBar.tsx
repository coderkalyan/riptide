import { For, createSignal, createEffect, onCleanup } from "solid-js";
import { Portal } from "solid-js/web";
import type { MenuItem } from "./ContextMenu";

// Basename of a path (cross-platform-ish: split on both separators).
const baseName = (p: string) => p.split(/[\\/]/).pop() || p;

// Static menu definitions. File items that depend on runtime state (Open Recent)
// are injected in `menus()` below. Linux keyboard shortcuts, plain text only.
const EDIT_PLUS: { name: string; items: MenuItem[] }[] = [
  { name: "Edit", items: [
    { label: "Undo", kbd: "Ctrl+Z", disabled: true }, { label: "Redo", kbd: "Ctrl+Shift+Z", disabled: true }, "sep",
    { label: "Cut", kbd: "Ctrl+X", disabled: true }, { label: "Copy", kbd: "Ctrl+C", disabled: true }, { label: "Paste", kbd: "Ctrl+V", disabled: true }, "sep", { label: "Find…", kbd: "Ctrl+F", disabled: true },
  ] },
  { name: "Signals", items: [
    { label: "Add Signal…", kbd: "⌘⏎" }, { label: "Group Selected" }, { label: "Remove from View" }, "sep",
    { label: "Set Radix" }, { label: "Change Color…" },
  ] },
  { name: "Help", items: [
    { label: "Documentation", disabled: true },
    { label: "Keyboard Shortcuts", kbd: "Ctrl+/", disabled: true },
    "sep",
    { label: "About Riptide", disabled: true },
  ] },
];

export function MenuBar(props: {
  onOpenVcd: () => void;
  onOpenRecent: (path: string) => void;
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

  const menus = (): { name: string; items: MenuItem[] }[] => [
    { name: "File", items: [
      { label: "New Window", kbd: "Ctrl+N", disabled: true },
      { label: "Open VCD…", kbd: "Ctrl+O", action: "open-vcd" },
      { label: "Open Recent", submenu: recentSubmenu() },
      "sep",
      { label: "Reload Trace", kbd: "Ctrl+R", disabled: true },
      "sep",
      { label: "Close Window", kbd: "Ctrl+W", action: "close-window" },
    ] },
    EDIT_PLUS[0], // Edit
    { name: "View", items: [
      { label: "Zoom In", kbd: "Ctrl+=", action: "zoom-in" },
      { label: "Zoom Out", kbd: "Ctrl+-", action: "zoom-out" },
      { label: "Zoom to Fit", kbd: "Ctrl+0", action: "zoom-fit" },
      "sep",
      { label: props.treeCollapsed() ? "Expand Signal Tree" : "Collapse Signal Tree", action: "toggle-tree" },
      { label: props.activeCollapsed() ? "Expand Active Signals" : "Compact Active Signals", action: "toggle-active" },
      "sep",
      { label: "Grid Snap", checked: props.snapOn(), action: "toggle-snap" },
      { label: "Align Grid to Clock", checked: props.clockOn(), action: "toggle-clock" },
      "sep",
      { label: "Reset Layout" },
    ] },
    EDIT_PLUS[1], // Signals
    { name: "Markers", items: [
      { label: "Add Marker at Cursor", kbd: "M", action: "marker-add" },
      { label: "Delete Marker", kbd: "Backspace", action: "marker-delete", disabled: !props.markerSelected() },
      { label: "Clear All Markers", action: "marker-clear", disabled: props.markerCount() === 0 },
      "sep",
      { label: "Next Marker", kbd: "]", action: "marker-next", disabled: props.markerCount() === 0 },
      { label: "Previous Marker", kbd: "[", action: "marker-prev", disabled: props.markerCount() === 0 },
    ] },
    ...EDIT_PLUS.slice(2),
  ];

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
  };

  const renderItem = (it: MenuItem, isSub: boolean) =>
    it === "sep" ? <div class="menu-sep" /> : (
      <div
        class={`menu-item${it.disabled ? " disabled" : ""}${!isSub && it.submenu && sub() ? " active" : ""}`}
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
