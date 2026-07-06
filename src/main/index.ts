import { app, BrowserWindow, Menu, dialog, ipcMain } from "electron";
import * as path from "node:path";
import fs from 'fs';

app.commandLine.appendSwitch("enable-unsafe-webgpu");
if (process.platform === "linux") {
  app.commandLine.appendSwitch("enable-features", "Vulkan");
}

// RenderDoc capture mode (RIPTIDE_RENDERDOC=1, or =inproc). Chromium runs
// WebGPU/Dawn's Vulkan in the sandboxed GPU child process, which RenderDoc can't
// hook by default; these switches make that Vulkan work capturable. Off unless
// the env var is set, so normal runs are unaffected.
const renderdoc = process.env.RIPTIDE_RENDERDOC;
if (renderdoc) {
  app.commandLine.appendSwitch("no-sandbox");
  // With --no-sandbox the zygote pre-fork still runs sandbox init and FATALs
  // (zygote_host_impl_linux.cc "Invalid argument"); --no-zygote disables it.
  app.commandLine.appendSwitch("no-zygote");
  app.commandLine.appendSwitch("disable-setuid-sandbox");
  app.commandLine.appendSwitch("disable-gpu-sandbox");
  // Don't let the watchdog kill the GPU process while RenderDoc stalls it to capture.
  app.commandLine.appendSwitch("disable-gpu-watchdog");
  app.commandLine.appendSwitch("disable-gpu-process-crash-limit");
  // RenderDoc hooks X11 + Vulkan reliably; Wayland WSI is flaky. Force XWayland.
  app.commandLine.appendSwitch("ozone-platform", "x11");
  // =inproc puts the GPU/Vulkan work in the launched process so RenderDoc
  // captures it directly (no child-process hook needed). It can destabilize
  // WebGPU on some drivers — if the canvas is blank, drop "inproc" and use
  // RenderDoc's "Capture Child Processes" option instead.
  if (renderdoc === "inproc") app.commandLine.appendSwitch("in-process-gpu");
}

// Recently-opened traces, most-recent first. Persisted to userData so the list
// survives restarts. Drives the File > Open Recent submenu AND the boot trace
// (see currentVcd below) — declared first so that init can read it.
const RECENT_MAX = 10;
const recentPath = () => path.join(app.getPath("userData"), "recent.json");
function readRecent(): string[] {
  try {
    const raw = JSON.parse(fs.readFileSync(recentPath(), "utf8"));
    return Array.isArray(raw) ? raw.filter((p) => typeof p === "string") : [];
  } catch {
    return [];
  }
}
function addRecent(p: string): void {
  const list = [p, ...readRecent().filter((x) => x !== p)].slice(0, RECENT_MAX);
  try {
    fs.writeFileSync(recentPath(), JSON.stringify(list));
  } catch (err) {
    console.error("[recent] write failed", err);
  }
}

// Window frame style (Linux only). "custom" = frameless window + in-app drawn
// window controls (default; the app already has its own titlebar row). "native" =
// the WM/OS draws the frame + buttons (a tiling WM strips them entirely — the
// "give me nothing" escape hatch). Persisted to userData so the choice survives
// restarts. Consulted ONLY on Linux; mac/Windows keep the Electron default frame.
type FrameStyle = "custom" | "native";
const framePrefPath = () => path.join(app.getPath("userData"), "frame.json");
function readFrameStyle(): FrameStyle {
  try {
    return JSON.parse(fs.readFileSync(framePrefPath(), "utf8")) === "native" ? "native" : "custom";
  } catch {
    return "custom";
  }
}
function writeFrameStyle(s: FrameStyle): void {
  try {
    fs.writeFileSync(framePrefPath(), JSON.stringify(s));
  } catch (err) {
    console.error("[frame] write failed", err);
  }
}

// Chrome param carried to the renderer (Linux + custom frame only) so it draws the
// in-app window controls. Empty on native frame or other platforms — the renderer
// then draws no controls (WM/OS owns the frame). The controls live left, where the
// title-bar dots sat; no side/order negotiation needed.
function chromeSearch(): string {
  if (process.platform !== "linux" || readFrameStyle() !== "custom") return "";
  return "&chrome=custom";
}

// The trace this window currently shows. The "Open VCD…" menu swaps it and
// reloads. The path is carried to the renderer in the window URL (?vcd=...) so a
// reload re-initializes the native db, hierarchy, and sidecar-derived view from
// scratch — no in-place reactive plumbing needed.
//
// Boot trace (dev AND release): the most recently opened trace that still exists
// on disk (from the persisted recent list). First-ever launch — or one where
// every remembered file is gone — has an empty list, so currentVcd starts empty:
// the window opens with `?vcd=` empty and the renderer sits idle (empty tree /
// canvas, no native queries) until the user opens a trace via File > Open VCD…
// (which records it, so the next launch reopens it). The bundled mock fixture is
// no longer auto-opened — open it explicitly if you want it.
//
// Overrides: RIPTIDE_NO_TRACE=1 forces the idle/empty boot (`pnpm dev:blank`);
// RIPTIDE_VCD=<path> boots a specific trace. Resolved in app.whenReady (not at
// module load) since the recent-list path needs app.getPath("userData").
let currentVcd = "";
function resolveBootTrace(): string {
  if (process.env.RIPTIDE_NO_TRACE) return "";
  if (process.env.RIPTIDE_VCD) return path.resolve(process.env.RIPTIDE_VCD);
  return readRecent().find((p) => fs.existsSync(p)) ?? "";
}

function loadTrace(win: BrowserWindow): void {
  const search = `vcd=${encodeURIComponent(currentVcd)}${chromeSearch()}`;
  if (process.env.RIPTIDE_DEV) {
    win.loadURL(`http://localhost:5173/?${search}`);
  } else {
    win.loadFile(path.join(app.getAppPath(), "dist/renderer/index.html"), { search });
  }
}

function createWindow(): void {
  // Linux "custom" frame → frameless; the app draws its own titlebar + controls.
  // Everywhere else (and Linux "native") keeps Electron's default OS frame.
  const frameless = process.platform === "linux" && readFrameStyle() === "custom";
  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    title: "riptide",
    frame: !frameless,
    autoHideMenuBar: true,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      sandbox: false,
      webviewTag: false,
    },
  });
  win.webContents.on("will-navigate", (e) => e.preventDefault());
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  // Keep the custom titlebar's maximize/restore glyph in sync with the real window
  // state (the WM can also (un)maximize, e.g. double-click or a keybind).
  const sendMax = () => win.webContents.send("riptide:maximized", win.isMaximized());
  win.on("maximize", sendMax);
  win.on("unmaximize", sendMax);
  loadTrace(win);
  // win.webContents.openDevTools({ mode: "detach" });
  //
  // Debug-only: capture the window to screenshot.png 1s after launch. Disabled
  // for release — in a packaged app the cwd is arbitrary, so this litters a
  // screenshot.png wherever the app was launched from (or throws EROFS/EACCES on
  // a read-only mount). Re-enable locally when you need a quick snapshot.
  // setTimeout(() => {
  //   win.capturePage().then(image => {
  //     fs.writeFileSync('screenshot.png', image.toPNG())
  //   })
  // }, 1000)
}

// Renderer ("Open VCD…") -> native file dialog. On a choice, reload the window
// pointed at the new trace. Returns the chosen path (or null if cancelled).
ipcMain.handle("riptide:open-vcd", async (e) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  if (!win) return null;
  const r = await dialog.showOpenDialog(win, {
    title: "Open VCD",
    properties: ["openFile"],
    filters: [{ name: "Value Change Dump", extensions: ["vcd"] }],
  });
  if (r.canceled || r.filePaths.length === 0) return null;
  // Return the chosen path; the renderer swaps the trace in place (no reload).
  // currentVcd is kept for bookkeeping (e.g. window title) but no longer drives
  // a navigation. loadTrace is still used by createWindow for the initial load.
  currentVcd = r.filePaths[0];
  addRecent(currentVcd);
  return currentVcd;
});

// Renderer asks for the recent-trace list (File > Open Recent submenu).
ipcMain.handle("riptide:recent-vcds", () => readRecent());

// Renderer opened a recent trace; bump it to the top of the list and track it as
// the current trace. The renderer swaps in place (no reload) after this returns.
ipcMain.handle("riptide:open-recent", (_e, p: string) => {
  currentVcd = p;
  addRecent(p);
  return p;
});

// Renderer captured the canvas as PNG bytes -> native save dialog, write file.
// Returns the chosen path (or null if cancelled).
ipcMain.handle("riptide:save-canvas", async (e, bytes: Uint8Array) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  if (!win) return null;
  const base = currentVcd ? path.basename(currentVcd).replace(/\.vcd$/i, "") : "waveform";
  const r = await dialog.showSaveDialog(win, {
    title: "Save Canvas Image",
    defaultPath: `${base}.png`,
    filters: [{ name: "PNG Image", extensions: ["png"] }],
  });
  if (r.canceled || !r.filePath) return null;
  fs.writeFileSync(r.filePath, Buffer.from(bytes));
  return r.filePath;
});

// Renderer built the stripped (view-only) sidecar text -> native save dialog,
// write file. Returns the chosen path (or null if cancelled).
ipcMain.handle("riptide:export-sidecar", async (e, text: string) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  if (!win) return null;
  const base = currentVcd ? path.basename(currentVcd).replace(/\.vcd$/i, "") : "view";
  // Default the dialog into the open trace's directory (Electron resolves a full
  // defaultPath to dir + prefilled name), so the sidecar lands next to its VCD.
  const defaultPath = currentVcd ? path.join(path.dirname(currentVcd), `${base}.sidecar.json`) : `${base}.sidecar.json`;
  const r = await dialog.showSaveDialog(win, {
    title: "Export Sidecar",
    defaultPath,
    filters: [{ name: "Riptide Sidecar", extensions: ["json"] }],
  });
  if (r.canceled || !r.filePath) return null;
  fs.writeFileSync(r.filePath, text);
  return r.filePath;
});

// Renderer ("Import Sidecar…") -> native open dialog; returns the chosen path (or
// null if cancelled). The renderer loads + validates + applies it against the
// currently-open trace (no VCD reload). Defaults into the open trace's directory.
ipcMain.handle("riptide:import-sidecar", async (e) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  if (!win) return null;
  const r = await dialog.showOpenDialog(win, {
    title: "Import Sidecar",
    defaultPath: currentVcd ? path.dirname(currentVcd) : undefined,
    properties: ["openFile"],
    filters: [{ name: "Riptide Sidecar", extensions: ["json"] }],
  });
  if (r.canceled || r.filePaths.length === 0) return null;
  return r.filePaths[0];
});

// Close the window that asked (File > Close Window).
ipcMain.handle("riptide:close-window", (e) => {
  BrowserWindow.fromWebContents(e.sender)?.close();
});

// Custom-titlebar (frameless Linux) window controls.
ipcMain.handle("riptide:minimize-window", (e) => {
  BrowserWindow.fromWebContents(e.sender)?.minimize();
});
ipcMain.handle("riptide:toggle-maximize", (e) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  if (!win) return;
  if (win.isMaximized()) win.unmaximize();
  else win.maximize();
});
ipcMain.handle("riptide:is-maximized", (e) => BrowserWindow.fromWebContents(e.sender)?.isMaximized() ?? false);

// Toggle the Linux frame style (custom in-app controls <-> native WM frame).
// Persist, then recreate the window so the new frame takes effect. currentVcd is
// module state and the view is autosaved to the sidecar, so the same trace + view
// reloads in the fresh window.
ipcMain.handle("riptide:set-frame-style", (e, style: FrameStyle) => {
  if (process.platform !== "linux") return;
  writeFrameStyle(style === "native" ? "native" : "custom");
  const old = BrowserWindow.fromWebContents(e.sender);
  createWindow();
  old?.close();
});

app.whenReady().then(() => {
  // The app draws its own MenuBar; drop the native/GTK application menu so no
  // stray menu bar wraps at the top of the window on Linux.
  Menu.setApplicationMenu(null);
  currentVcd = resolveBootTrace();
  createWindow();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
