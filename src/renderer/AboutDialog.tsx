import { Match, Switch, onMount, onCleanup } from "solid-js";
import { Portal } from "solid-js/web";
import type { UpdateStatus } from "../shared/update";

declare const require: (m: string) => unknown;
// Node global (nodeIntegration renderer); the renderer tsconfig deliberately
// carries no node types, same as the `require` declaration above.
declare const process: { versions: { electron: string; chrome: string; node: string } };

// Version/description come from package.json — resolved relative to
// dist/renderer/, this reaches the app root (app.asar root when packaged), the
// same relative-require pattern native.ts uses for the addon.
const pkg = (() => {
  try {
    return require("../../package.json") as { version: string; description?: string };
  } catch {
    return { version: "dev", description: undefined };
  }
})();

// Runtime versions straight off the Node globals (nodeIntegration renderer).
const runtimeLine = (() => {
  try {
    const v = process.versions;
    return `Electron ${v.electron} · Chromium ${v.chrome.split(".")[0]} · Node ${v.node}`;
  } catch {
    return null;
  }
})();

// Help ▸ About Riptide, and Help ▸ Check for Updates. Info card on the shared .modal
// chrome; dismiss on backdrop, Esc, or the button.
//
// The update section lives here rather than in its own dialog so there is exactly one
// place that reports version state. `update` is owned by the main process
// (src/main/updater.ts); this component only renders it and fires intents back.
export function AboutDialog(props: {
  onClose: () => void;
  onOpenUrl: (url: string) => void;
  update: UpdateStatus;
  onCheck: () => void;
  onDownload: () => void;
  onRestart: () => void;
}) {
  onMount(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") props.onClose(); };
    document.addEventListener("keydown", onKey);
    onCleanup(() => document.removeEventListener("keydown", onKey));
  });
  return (
    <Portal>
      <div class="modal-backdrop" onMouseDown={props.onClose}>
        <div class="modal about-modal" onMouseDown={(e) => e.stopPropagation()}>
          {/* The product mark, identical to build/icon.svg and the website's:
              stroke=currentColor so it picks up .about-mark's accent colour. */}
          <div class="about-mark">
            <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                 stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M2 14 L6 14 L6 7 L11 7 L11 17 L16 17 L16 11 L22 11" />
            </svg>
          </div>
          <div class="about-name">Riptide</div>
          <div class="about-version">Version {pkg.version}</div>
          {pkg.description && <div class="about-desc">{pkg.description}</div>}
          {runtimeLine && <div class="about-meta">{runtimeLine}</div>}
          <div class="about-meta">Copyright © 2026 Kalyan Sriram · AGPL-3.0-or-later</div>
          <Switch>
            {/* Nothing checked yet this session (the boot check is delayed, and it
                resets to idle on a silent failure). Offer the check rather than
                claiming a state we do not have. */}
            <Match when={props.update.kind === "idle"}>
              <button class="link about-update" onClick={props.onCheck}>Check for updates</button>
            </Match>
            <Match when={props.update.kind === "checking"}>
              <div class="about-update muted">Checking for updates…</div>
            </Match>
            <Match when={props.update.kind === "current"}>
              <div class="about-update muted">Riptide is up to date.</div>
            </Match>
            {/* electron-updater can install this one; ask before spending the bandwidth. */}
            <Match when={props.update.kind === "available" && props.update}>{(u) => (
              <div class="about-update">
                <div>Version {u().version} is available.</div>
                <button class="btn" onClick={props.onDownload}>Download</button>
              </div>
            )}</Match>
            <Match when={props.update.kind === "downloading" && props.update}>{(u) => (
              <div class="about-update">
                <div class="muted">Downloading {u().version}… {u().percent}%</div>
                <div class="about-progress"><div style={{ width: `${u().percent}%` }} /></div>
              </div>
            )}</Match>
            {/* AppImage/NSIS install on the next quit (main sets autoInstallOnAppQuit), so
                restarting is an offer, not a demand — this app gets left open during long
                debugging sessions and must never seize the moment. A deb cannot do that:
                dpkg needs an admin prompt, so it says plainly that a restart is required
                rather than quietly never installing. */}
            <Match when={props.update.kind === "ready" && props.update}>{(u) => (
              <div class="about-update">
                <div>
                  {u().installOnQuit
                    ? `Version ${u().version} installs when you quit.`
                    : `Version ${u().version} is ready to install.`}
                </div>
                <button class="btn" onClick={props.onRestart}>Restart Now</button>
                {!u().installOnQuit && <div class="about-meta">Installing asks for administrator access.</div>}
              </div>
            )}</Match>
            {/* This build cannot update itself — macOS (ad-hoc signed) or the Windows
                portable exe. Say so plainly and send them to the release. */}
            <Match when={props.update.kind === "manual" && props.update}>{(u) => (
              <div class="about-update">
                <div>Version {u().version} is available.</div>
                <button class="btn" onClick={() => props.onOpenUrl(u().url)}>Open Download Page</button>
                <div class="about-meta">This build cannot update itself.</div>
              </div>
            )}</Match>
            <Match when={props.update.kind === "error" && props.update}>{(u) => (
              <div class="about-update">
                <div class="muted">Update check failed: {u().message}</div>
                <button class="link" onClick={props.onCheck}>Try again</button>
              </div>
            )}</Match>
          </Switch>
          {/* AGPL expects users to be told where the source lives, so make it
              reachable: a button rather than an <a href>, which would navigate the
              app window away instead of opening a browser. */}
          <button class="link" onClick={() => props.onOpenUrl("https://github.com/coderkalyan/riptide")}>
            github.com/coderkalyan/riptide
          </button>
          <div class="modal-actions">
            <button class="btn primary" onClick={props.onClose}>Close</button>
          </div>
        </div>
      </div>
    </Portal>
  );
}
