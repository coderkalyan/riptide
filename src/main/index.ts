import { app, BrowserWindow } from "electron";
import * as path from "node:path";

app.commandLine.appendSwitch("enable-unsafe-webgpu");
if (process.platform === "linux") {
    app.commandLine.appendSwitch("enable-features", "Vulkan");
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
    if (process.env.RIPTIDE_DEV) {
        win.loadURL("http://localhost:5173");
    } else {
        win.loadFile(path.join(app.getAppPath(), "dist/renderer/index.html"));
    }
    // win.webContents.openDevTools({ mode: "detach" });
}

app.whenReady().then(createWindow);

app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
});
