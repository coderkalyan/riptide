import { app, BrowserWindow, dialog, ipcMain } from "electron";
import * as path from "node:path";
import fs from 'fs';

app.commandLine.appendSwitch("enable-unsafe-webgpu");
if (process.platform === "linux") {
  app.commandLine.appendSwitch("enable-features", "Vulkan");
}

// The trace this window currently shows. Defaults to the bundled mock; the
// "Open VCD…" menu swaps it and reloads. The path is carried to the renderer in
// the window URL (?vcd=...) so a reload re-initializes the native db, hierarchy,
// and sidecar-derived view from scratch — no in-place reactive plumbing needed.
let currentVcd = path.join(app.getAppPath(), "native/src/mock.vcd");

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
  setTimeout(() => {
    win.capturePage().then(image => {
      fs.writeFileSync('screenshot.png', image.toPNG())
    })
  }, 1000)
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
  currentVcd = r.filePaths[0];
  loadTrace(win);
  return currentVcd;
});

app.whenReady().then(createWindow);

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
