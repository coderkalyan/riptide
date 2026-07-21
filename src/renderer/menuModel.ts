// Single source of truth for the app menu (File / Edit / View / Signals / Markers /
// Help). Framework-agnostic: `buildMenus` maps a plain state snapshot to a section
// tree of `MenuItem`s. Two consumers render it:
//   - MenuBar.tsx (Linux/Windows) — the in-app SolidJS titlebar menu.
//   - the native macOS menu — App.tsx serializes these sections over IPC and the main
//     process (src/main/menu.ts) turns them into a real Electron menu.
// Keep all menu content here so the two renderers never drift.
import type { MenuItem } from "./ContextMenu";

// Plain snapshot of the document/UI state the menu labels + enabled/checked flags
// depend on. Assembled reactively in App.tsx and passed to both consumers.
export type MenuState = {
  idle: boolean; // no trace loaded — only Open / Open Recent / Close stay live
  treeCollapsed: boolean;
  activeCollapsed: boolean;
  snapOn: boolean;
  clockOn: boolean;
  clockAvailable: boolean; // false → Align-to-Clock disabled (no clock signal)
  markerCount: number;
  markerSelected: boolean;
  signalSelected: boolean;
  signalHidden: boolean;
  linux: boolean; // gates the Linux-only "System Title Bar" frame toggle
  frameStyle: "custom" | "native";
};

// Basename of a path (cross-platform-ish: split on both separators).
const baseName = (p: string) => p.split(/[\\/]/).pop() || p;

// Edit + Help are state-independent (static placeholders for now). Unimplemented
// items carry no `kbd` — advertising a shortcut that does nothing reads as broken.
const EDIT_HELP: { name: string; items: MenuItem[] }[] = [
  { name: "Edit", items: [
    { label: "Undo", disabled: true, unimplemented: true }, { label: "Redo", disabled: true, unimplemented: true }, "sep",
    { label: "Cut", disabled: true, unimplemented: true }, { label: "Copy", disabled: true, unimplemented: true }, { label: "Paste", disabled: true, unimplemented: true }, "sep", { label: "Find…", disabled: true, unimplemented: true },
  ] },
  { name: "Help", items: [
    { label: "Documentation", disabled: true, unimplemented: true },
    { label: "Keyboard Shortcuts", disabled: true, unimplemented: true },
    "sep",
    { label: "About Riptide", action: "about" },
  ] },
];

// The full menu tree for the given state + recent-trace list. Actions are opaque
// strings dispatched by App.tsx `runMenuAction` (shared by both renderers).
export function buildMenus(s: MenuState, recent: string[]): { name: string; items: MenuItem[] }[] {
  const idle = s.idle;
  const recentSub: MenuItem[] =
    recent.length === 0
      ? [{ label: "No Recent Traces", disabled: true }]
      : recent.map((p) => ({ label: baseName(p), action: "open-recent", path: p }));

  return [
    { name: "File", items: [
      { label: "New Window", disabled: true, unimplemented: true },
      { label: "Open VCD…", kbd: "Ctrl+O", action: "open-vcd" },
      { label: "Open Recent", submenu: recentSub },
      "sep",
      { label: "Import Sidecar…", action: "import-sidecar", disabled: idle },
      { label: "Export Sidecar…", action: "export-sidecar", disabled: idle },
      "sep",
      // Reloads the open trace from disk — replaces the in-app reload pill, which has
      // no home on the native macOS frame.
      { label: "Reload File", kbd: "Ctrl+R", action: "reload-trace", disabled: idle },
      "sep",
      { label: "Close Window", kbd: "Ctrl+W", action: "close-window" },
    ] },
    EDIT_HELP[0], // Edit
    { name: "View", items: [
      { label: "Zoom In", kbd: "Ctrl+=", action: "zoom-in", disabled: idle },
      { label: "Zoom Out", kbd: "Ctrl+-", action: "zoom-out", disabled: idle },
      { label: "Zoom to Fit", kbd: "Ctrl+0", action: "zoom-fit", disabled: idle },
      "sep",
      { label: s.treeCollapsed ? "Expand Signal Tree" : "Collapse Signal Tree", action: "toggle-tree", disabled: idle },
      { label: s.activeCollapsed ? "Expand Active Signals" : "Compact Active Signals", action: "toggle-active", disabled: idle },
      "sep",
      { label: "Grid Snap", checked: s.snapOn, action: "toggle-snap", disabled: idle },
      { label: "Align Grid to Clock", checked: s.clockOn, action: "toggle-clock", disabled: idle || !s.clockAvailable },
      "sep",
      { label: "Reset Layout", disabled: true, unimplemented: true },
      ...(s.linux
        ? ["sep" as MenuItem, { label: "System Title Bar", checked: s.frameStyle === "native", action: "toggle-frame" } as MenuItem]
        : []),
    ] },
    { name: "Signals", items: [
      // "Dim", not "Hide": the eye toggle dims the row (RowInfo dim flag), it
      // doesn't remove it — matches the row tooltip + context-menu wording.
      { label: s.signalHidden ? "Undim Signal" : "Dim Signal", action: "signal-hide", disabled: idle || !s.signalSelected },
      { label: "Change Color…", action: "signal-color", disabled: idle || !s.signalSelected },
      "sep",
      { label: "Move to Top", action: "signal-top", disabled: idle || !s.signalSelected },
      { label: "Move to Bottom", action: "signal-bottom", disabled: idle || !s.signalSelected },
      "sep",
      { label: "Remove from View", action: "signal-remove", disabled: idle || !s.signalSelected },
    ] },
    { name: "Markers", items: [
      { label: "Add Marker at Cursor", kbd: "M", action: "marker-add", disabled: idle },
      { label: "Delete Marker", kbd: "Backspace", action: "marker-delete", disabled: idle || !s.markerSelected },
      { label: "Clear All Markers", action: "marker-clear", disabled: idle || s.markerCount === 0 },
      "sep",
      { label: "Next Marker", kbd: "]", action: "marker-next", disabled: idle || s.markerCount === 0 },
      { label: "Previous Marker", kbd: "[", action: "marker-prev", disabled: idle || s.markerCount === 0 },
    ] },
    EDIT_HELP[1], // Help
  ];
}
