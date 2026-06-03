// Dev harness main process for the SolidJS renderer. Loads the built Solid
// bundle (dist/renderer-solid) over file:// — which is how the native addon's
// relative require ("../native/riptide.node") resolves (against the HTML dir →
// dist/native). The http dev-server path (RIPTIDE_DEV → :5173) cannot load the
// native addon, so this harness is used to run/verify the Solid app until the
// real main (src/main/index.ts) is wired to it in Phase 6.
//
// Mirrors src/main/index.ts's window config + GPU switches. Throwaway: not the
// production main.
const { app, BrowserWindow } = require("electron");
const path = require("node:path");

app.commandLine.appendSwitch("enable-unsafe-webgpu");
if (process.platform === "linux") app.commandLine.appendSwitch("enable-features", "Vulkan");

const vcd = process.env.RIPTIDE_VCD
  ? path.resolve(process.env.RIPTIDE_VCD)
  : path.join(__dirname, "..", "native/src/mock.vcd");
const html = path.join(__dirname, "..", "dist/renderer-solid/index.html");

function createWindow() {
  const win = new BrowserWindow({
    width: 1400, height: 900, title: "riptide (solid)", autoHideMenuBar: true,
    webPreferences: { nodeIntegration: true, contextIsolation: false, sandbox: false, webviewTag: false },
  });
  win.webContents.on("will-navigate", (e) => e.preventDefault());
  win.loadFile(html, { search: `vcd=${encodeURIComponent(vcd)}` });
}

app.whenReady().then(createWindow);
app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
