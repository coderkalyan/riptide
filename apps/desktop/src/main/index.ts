import { app, BrowserWindow } from "electron";
import * as path from "node:path";

// if (process.platform === "linux" && process.env.WAYLAND_DISPLAY) {
//     app.commandLine.appendSwitch("ozone-platform", "wayland");
//     app.commandLine.appendSwitch("enable-features", "WaylandWindowDecorations,Vulkan");
// }
app.commandLine.appendSwitch("enable-unsafe-webgpu");
if (process.platform === "linux") {
    app.commandLine.appendSwitch("enable-features", "Vulkan");
    app.commandLine.appendSwitch("disable-gpu-sandbox");
}

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
