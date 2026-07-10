// Native (Electron) application menu translator. This module itself is *platform-agnostic*:
// it renders whatever section tree the renderer ships over `riptide:menu-descriptor` (built
// by the shared `menuModel.buildMenus`, the single source of truth for menu content) into a
// real Electron menu, and routes every click back to the focused renderer as an action
// string over `riptide:menu-action` (dispatched by App.tsx `runMenuAction`). It knows nothing
// about specific labels or actions — so the menu content lives in exactly one place.
//
// In practice it is only ever invoked on macOS (both call sites in index.ts are guarded by
// `process.platform === "darwin"`): there the app uses the native window frame + the system
// menu bar (top of screen) instead of the in-app SolidJS MenuBar (the custom titlebar is
// hidden — see App.tsx `IS_MAC`), and the leading `role: 'appMenu'` below is the standard
// macOS Riptide ▸ About/Hide/Quit menu. Linux/Windows keep the in-app menu and never build
// this (`setApplicationMenu(null)`); `appMenu` degrades to a plain "Riptide" submenu there
// anyway. Nothing in the translation logic is mac-specific, so it stays reusable if another
// platform ever adopts a native menu bar.
import { Menu, BrowserWindow, type MenuItemConstructorOptions } from "electron";

// Mirror of the renderer's `MenuItem` (ContextMenu.ts) — only the fields the menu tree
// actually uses. Arrives via IPC (structured-clone of plain objects), so no functions.
type MenuItem =
  | "sep"
  | {
      label: string;
      kbd?: string;
      disabled?: boolean;
      submenu?: MenuItem[];
      action?: string;
      path?: string;
      checked?: boolean;
    };
type Section = { name: string; items: MenuItem[] };

function send(action: string, path?: string): void {
  BrowserWindow.getFocusedWindow()?.webContents.send("riptide:menu-action", { action, path });
}

// Turn a `kbd` hint into a native accelerator. Only modifier chords (e.g. "Ctrl+O")
// become accelerators — rewritten to CmdOrCtrl so mac uses ⌘. Bare single keys
// (m, [, ], Backspace) return undefined: those stay renderer-owned (WaveCanvas guards
// text-input focus), and a bare-key menu accelerator would fire globally and both
// break typing and double-trigger.
function accelerator(kbd?: string): string | undefined {
  if (!kbd || !kbd.includes("+")) return undefined;
  return kbd.replace(/^Ctrl\+/, "CmdOrCtrl+");
}

function mapItem(it: MenuItem): MenuItemConstructorOptions {
  if (it === "sep") return { type: "separator" };
  if (it.submenu) return { label: it.label, enabled: !it.disabled, submenu: it.submenu.map(mapItem) };
  const o: MenuItemConstructorOptions = { label: it.label, enabled: !it.disabled, accelerator: accelerator(it.kbd) };
  if (it.checked !== undefined) { o.type = "checkbox"; o.checked = it.checked; }
  if (it.action) o.click = () => send(it.action!, it.path);
  return o;
}

// Build + install the application menu from the renderer's section tree. The leading
// `role: 'appMenu'` is the standard mac Riptide ▸ About / Hide / Quit menu (platform
// chrome, not app content). An empty `sections` yields just that — the bootstrap menu
// installed before the renderer's first descriptor arrives.
export function installNativeMenu(sections: Section[]): void {
  const template: MenuItemConstructorOptions[] = [
    { role: "appMenu" },
    ...sections.map((s) => ({ label: s.name, submenu: s.items.map(mapItem) })),
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}
