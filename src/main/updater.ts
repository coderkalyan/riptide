// Auto-update against GitHub Releases.
//
// Two paths, because our distributables are not equally updatable:
//
//   Linux AppImage   — electron-updater (AppImageUpdater). Swaps the AppImage in place.
//   Linux deb        — electron-updater (DebUpdater). Runs `dpkg -i` through pkexec/sudo,
//                      so it needs an admin prompt and CANNOT install silently at quit —
//                      a password dialog during shutdown either hangs or is dismissed
//                      unseen. deb therefore installs only on an explicit Restart Now.
//   Windows NSIS     — electron-updater (NsisUpdater). Reruns the installer silently.
//   Linux tar.gz     — MANUAL. An extracted folder has no installer and no package
//                      manager entry; there is nothing to hand an update to.
//   Windows portable — MANUAL. A portable .exe is not an updatable target: electron-builder
//                      sets `isWriteUpdateInfo: false` for it, and NsisUpdater would try to
//                      drive it with installer flags (/S, /D=) it does not implement.
//   macOS dmg        — MANUAL. Squirrel.Mac captures the running bundle's *designated
//                      requirement* and demands the downloaded bundle satisfy it. Our builds
//                      are ad-hoc signed (electron-builder.yml `mac.identity: "-"`), and an
//                      ad-hoc DR is `cdhash H"<hash>"` — bound to that one exact binary, so
//                      v2 can never satisfy v1's DR. Fixing this needs a Developer ID
//                      Application certificate, not a config change. The `zip` target is
//                      already built and shipped so that flipping this on is a one-line
//                      change the day a certificate exists.
//
// The manual path runs the same version check against the GitHub API and then hands the
// user off to the releases page in their browser. It never pretends an in-app update
// happened. It is deliberately not a "do nothing" path: silently hiding that a new version
// exists is worse than asking for one click.
import { app, BrowserWindow, ipcMain } from "electron";
import * as https from "node:https";
import * as fs from "node:fs";
import * as path from "node:path";
import semver from "semver";
import { sendToWindow } from "./send";
import type { AppUpdater } from "electron-updater";
import type { UpdateStatus } from "../shared/update";

const REPO_OWNER = "coderkalyan";
const REPO_NAME = "riptide";
const RELEASES_URL = `https://github.com/${REPO_OWNER}/${REPO_NAME}/releases`;
// Where electron-builder's deb target installs (data.tar → ./opt/<productName>/). Used to
// tell an installed deb apart from an extracted tar.gz, which is packed from the same
// staging directory and can therefore carry the same marker file.
const DEB_INSTALL_PREFIX = "/opt/Riptide";
// Delay the boot check so it never competes with the first trace load / first paint.
const STARTUP_CHECK_DELAY_MS = 5_000;

let status: UpdateStatus = { kind: "idle" };
// Guards a manual click racing the boot check into two concurrent checks.
let inFlight = false;
// Errors during the boot check are logged and dropped: an unprompted "update check failed"
// on every offline launch is noise. A user-initiated check always reports.
let silent = false;
// One-shot guard for the "which updater am I" log line below.
let loggedKind = false;

function setStatus(next: UpdateStatus): void {
  status = next;
  // sendToWindow, not a raw send: a crashed renderer keeps its BrowserWindow, so an
  // unguarded broadcast would throw here on every status change after a crash.
  for (const win of BrowserWindow.getAllWindows()) sendToWindow(win, "riptide:update-status", next);
}

function fail(err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  console.error("[updater]", message);
  setStatus(silent ? { kind: "idle" } : { kind: "error", message });
}

// Which electron-updater implementation this artifact needs, or null when it cannot
// update itself in place.
//
// Deliberately NOT electron-updater's own `autoUpdater` export: its factory picks the
// Linux class by reading `resources/package-type`, and electron-builder's FpmTarget
// writes that file into the SHARED linux-unpacked/resources dir (FpmTarget.ts) — the same
// directory the AppImage and tar.gz are packed from. Whether the AppImage ends up
// carrying `package-type: deb` is pure target-build-order luck, and if it ever does, the
// factory hands AppImage users a DebUpdater that tries to `sudo dpkg -i` an AppImage.
// Checking APPIMAGE first makes the choice deterministic regardless of build order.
type UpdaterKind = "appimage" | "deb" | "nsis" | null;
function updaterKind(): UpdaterKind {
  // AppUpdater.isUpdaterActive() refuses unpackaged apps outright.
  if (!app.isPackaged) return null;
  switch (process.platform) {
    // Ad-hoc signature — Squirrel.Mac can never accept our update. See the header.
    case "darwin":
      return null;
    // PORTABLE_EXECUTABLE_FILE is set by electron-builder's portable stub. It is the
    // reliable test, not the presence of resources/app-update.yml: the nsis target in the
    // same build writes that into the shared app dir, so the portable exe carries it too.
    case "win32":
      return process.env.PORTABLE_EXECUTABLE_FILE == null ? "nsis" : null;
    case "linux": {
      // Set by the AppImage runtime. Checked FIRST so a stray package-type — see above —
      // can never mislabel an AppImage as a deb.
      if (process.env.APPIMAGE != null) return "appimage";
      // A deb is identified by BOTH the marker file and living where dpkg put it.
      // package-type alone is not enough for the same build-order reason: the tar.gz is
      // packed from that same shared dir, and a tar.gz that inherited the marker would
      // otherwise be handed a DebUpdater that installs a system package the user never
      // asked for. Requiring the install prefix makes the failure direction safe — an
      // unrecognised layout degrades to the manual path, never to running dpkg.
      if (!process.execPath.startsWith(`${DEB_INSTALL_PREFIX}/`)) return null;
      try {
        const marker = fs.readFileSync(path.join(process.resourcesPath, "package-type"), "utf8").trim();
        return marker === "deb" ? "deb" : null;
      } catch {
        // No marker: tar.gz, or a layout we do not recognise. Manual.
        return null;
      }
    }
    default:
      return null;
  }
}

// GET a URL as JSON. Plain node:https rather than fetch: this is the only network call the
// main process makes, and it wants a hard timeout more than it wants ergonomics.
function getJson(url: string): Promise<unknown> {
  const { promise, resolve, reject } = Promise.withResolvers<unknown>();
  const req = https.get(
    url,
    {
      // GitHub rejects API requests that send no User-Agent.
      headers: { "User-Agent": `riptide/${app.getVersion()}`, Accept: "application/vnd.github+json" },
      timeout: 10_000,
    },
    (res) => {
      // Unauthenticated API calls are rate-limited to 60/hr/IP. One check per launch is
      // nowhere near that, but a shared NAT could be — surface it as a normal failure
      // rather than letting an error body fall through to JSON.parse.
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`GitHub API returned ${res.statusCode}`));
        return;
      }
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (c) => { body += c; });
      res.on("end", () => {
        try { resolve(JSON.parse(body)); } catch (err) { reject(err); }
      });
    },
  );
  req.on("timeout", () => req.destroy(new Error("GitHub API request timed out")));
  req.on("error", reject);
  return promise;
}

// Newest published release strictly newer than this build, or null.
//
// `/releases` rather than `/releases/latest`: every Riptide release so far is flagged as a
// pre-release, and `/releases/latest` excludes those by definition. Drafts are invisible to
// unauthenticated callers (that is what keeps CI's draft builds from being offered to
// users), but filter them anyway so an authenticated proxy cannot change that.
async function latestManualRelease(): Promise<{ version: string; url: string } | null> {
  const data = await getJson(
    `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/releases?per_page=20`,
  );
  if (!Array.isArray(data)) throw new Error("unexpected GitHub API response");

  const current = app.getVersion();
  let best: { version: string; url: string } | null = null;
  for (const raw of data) {
    const rel = raw as { tag_name?: unknown; html_url?: unknown; draft?: unknown };
    if (rel.draft === true || typeof rel.tag_name !== "string") continue;
    // Tags are `v<version>`; release.yml refuses to publish a tag that disagrees with
    // package.json. Anything that is not plain semver after the v is not ours — skip it
    // rather than coerce, so a stray tag cannot masquerade as a release.
    const version = rel.tag_name.replace(/^v/, "");
    if (semver.valid(version) == null) continue;
    if (!semver.gt(version, current)) continue;
    if (best != null && !semver.gt(version, best.version)) continue;
    best = { version, url: typeof rel.html_url === "string" ? rel.html_url : RELEASES_URL };
  }
  return best;
}

// Lazily required: electron-updater drags in a sizeable dependency tree, and the artifacts
// that can never use it (macOS, tar.gz, Windows portable) should not pay for it at boot.
// The `import type`s are erased at compile time, so they do not defeat that.
type UpdaterModule = {
  AppImageUpdater: new () => AppUpdater;
  DebUpdater: new () => AppUpdater;
  NsisUpdater: new () => AppUpdater;
};
let cachedUpdater: AppUpdater | null = null;
function updater(kind: Exclude<UpdaterKind, null>): AppUpdater {
  if (cachedUpdater != null) return cachedUpdater;
  const eu = require("electron-updater") as UpdaterModule;
  const autoUpdater =
    kind === "appimage" ? new eu.AppImageUpdater()
    : kind === "deb" ? new eu.DebUpdater()
    : new eu.NsisUpdater();

  // Consent flow: never download without the user asking.
  autoUpdater.autoDownload = false;
  // Install when the app next exits rather than interrupting a debugging session —
  // BaseUpdater's quit handler calls install(isSilent = true), so no installer UI appears.
  // NOT for deb: its install shells out to pkexec/sudo `dpkg -i`, and a graphical password
  // prompt raised while the app is already tearing down is at best missed and at worst a
  // hung quit. deb waits for an explicit Restart Now, with the user watching.
  autoUpdater.autoInstallOnAppQuit = kind !== "deb";

  autoUpdater.on("update-available", (info) => setStatus({ kind: "available", version: info.version }));
  autoUpdater.on("update-not-available", () => setStatus({ kind: "current" }));
  autoUpdater.on("download-progress", (p) => {
    // Keep the version label stable across available → downloading → ready. The event
    // itself carries only progress, so carry the version forward from the current status.
    if (status.kind !== "downloading") return;
    setStatus({ kind: "downloading", version: status.version, percent: Math.round(p.percent) });
  });
  autoUpdater.on("update-downloaded", (info) =>
    setStatus({ kind: "ready", version: info.version, installOnQuit: kind !== "deb" }),
  );
  autoUpdater.on("error", (err) => fail(err));

  cachedUpdater = autoUpdater;
  return autoUpdater;
}

async function check(isSilent: boolean): Promise<void> {
  if (inFlight) return;
  inFlight = true;
  silent = isSilent;
  setStatus({ kind: "checking" });
  try {
    const kind = updaterKind();
    // Logged once per check: "which updater am I?" is the first question any update bug
    // raises, and it depends on env vars and a packaged resource file that are invisible
    // from the outside.
    if (!loggedKind) { loggedKind = true; console.log(`[updater] mode=${kind ?? "manual"}`); }
    if (kind != null) {
      // electron-updater reports its own failures: checkForUpdates() emits "error" and
      // *then* rethrows, so awaiting the rejection here too would report the same failure
      // twice. Swallow it and let the listener installed in updater() own it.
      const result = await updater(kind).checkForUpdates().catch(() => null);
      // A null result with the status untouched means isUpdaterActive() went false between
      // our guard and the call — that path emits nothing at all on its own. If the error
      // listener already moved us off "checking", leave its verdict alone.
      if (result == null && status.kind === "checking") setStatus({ kind: "current" });
    } else {
      // The manual path is ours, so its failures are ours to report.
      const rel = await latestManualRelease();
      setStatus(rel == null ? { kind: "current" } : { kind: "manual", ...rel });
    }
  } catch (err) {
    fail(err);
  } finally {
    inFlight = false;
  }
}

export function initUpdater(): void {
  // Late-opened windows (and the About dialog) pull the current state rather than waiting
  // for the next broadcast.
  ipcMain.handle("riptide:update-status", () => status);

  ipcMain.handle("riptide:update-check", async () => {
    await check(false);
    return status;
  });

  // Consent given. Only reachable from "available", i.e. the electron-updater path.
  ipcMain.handle("riptide:update-download", async () => {
    const kind = updaterKind();
    if (status.kind !== "available" || kind == null) return status;
    silent = false;
    setStatus({ kind: "downloading", version: status.version, percent: 0 });
    // Same double-report rejection as checkForUpdates; the "error" listener owns it.
    await updater(kind).downloadUpdate().catch(() => undefined);
    return status;
  });

  // Shortcut past "installs on next quit" — and for deb the ONLY way it installs, since
  // its pkexec/sudo prompt needs the user present.
  ipcMain.handle("riptide:update-restart", () => {
    const kind = updaterKind();
    if (status.kind !== "ready" || kind == null) return false;
    // isSilent — run the NSIS installer with no UI. Ignored by AppImageUpdater; DebUpdater
    // still raises its own privilege-escalation dialog regardless.
    updater(kind).quitAndInstall(true, true);
    return true;
  });

  setTimeout(() => { void check(true); }, STARTUP_CHECK_DELAY_MS);
}
