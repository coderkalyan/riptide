import { app, BrowserWindow, dialog, ipcMain } from "electron";
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

// The trace this window currently shows. Defaults to the bundled mock; the
// "Open VCD…" menu swaps it and reloads. The path is carried to the renderer in
// the window URL (?vcd=...) so a reload re-initializes the native db, hierarchy,
// and sidecar-derived view from scratch — no in-place reactive plumbing needed.
// The bundled mock + its curated sidecar are copied to dist/native (build:native)
// and asar-UNPACKED (package.json asarUnpack "dist/native/**"): the native tide-vcd
// addon reads via raw libc IO and CANNOT see inside app.asar, so the trace path must
// resolve to the unpacked tree. In dev (`electron .`) getAppPath() is the repo root
// and the replace is a no-op (dist/native/mock.vcd exists after `pnpm build`).
const appUnpacked = app.getAppPath().replace(/app\.asar$/, "app.asar.unpacked");
let currentVcd = process.env.RIPTIDE_VCD
  ? path.resolve(process.env.RIPTIDE_VCD)
  : path.join(appUnpacked, "dist/native/mock.vcd");

// Recently-opened traces, most-recent first. Persisted to userData so the list
// survives restarts. Drives the File > Open Recent submenu.
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

function loadTrace(win: BrowserWindow): void {
  const search = `vcd=${encodeURIComponent(currentVcd)}`;
  if (process.env.RIPTIDE_DEV) {
    win.loadURL(`http://localhost:5173/?${search}`);
  } else {
    win.loadFile(path.join(app.getAppPath(), "dist/renderer/index.html"), { search });
  }
}

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    title: "riptide",
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
  loadTrace(win);
  // win.webContents.openDevTools({ mode: "detach" });
  //
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

// Close the window that asked (File > Close Window).
ipcMain.handle("riptide:close-window", (e) => {
  BrowserWindow.fromWebContents(e.sender)?.close();
});

app.whenReady().then(createWindow);

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
