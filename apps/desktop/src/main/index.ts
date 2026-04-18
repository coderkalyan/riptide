import { app, BrowserWindow } from "electron";
import * as path from "node:path";


function createWindow(): void {
    const win = new BrowserWindow({
        width: 1400,
        height: 900,
        title: "riptide",
    });
    win.loadFile(path.join(app.getAppPath(), "dist/renderer/index.html"));
    win.webContents.openDevTools({ mode: "detach" });
}

app.whenReady().then(createWindow);

app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
});
