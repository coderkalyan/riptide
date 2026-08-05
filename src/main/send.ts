import type { BrowserWindow } from "electron";

// Every main→renderer message goes through here.
//
// When the renderer process dies its BrowserWindow stays alive with a disposed render
// frame, and `webContents.send()` in that state produces
//   Error sending from webFrameMain: Error: Render frame was disposed before
//   WebFrameMain could be accessed
// Note that Electron CATCHES that internally and logs it — send() does not throw — so a
// try/catch cannot suppress it. The only way to stay quiet is to not call send at all,
// which is what `isCrashed()` buys us. `isDestroyed()` is not enough on its own: it
// describes the window/webContents object, which outlives the render frame.
//
// Why it matters beyond a log line: it fires from whatever triggered the send — a WM
// maximize, an update broadcast — so one dead renderer turns into a stream of
// unrelated-looking main-process errors that bury the actual cause. Recovery belongs to
// the `render-process-gone` handler in index.ts; this function's only job is to not add
// noise. The try/catch remains for the window between a frame dying and isCrashed()
// reflecting it (e.g. a plain navigation teardown, which is not a crash).
export function sendToWindow(win: BrowserWindow, channel: string, ...args: unknown[]): void {
  if (win.isDestroyed() || win.webContents.isDestroyed() || win.webContents.isCrashed()) return;
  try {
    win.webContents.send(channel, ...args);
  } catch (err) {
    console.warn(`[ipc] dropped "${channel}":`, err instanceof Error ? err.message : err);
  }
}
