import { onMount, onCleanup } from "solid-js";
import { Portal } from "solid-js/web";

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

// Help ▸ About Riptide. Static info card on the shared .modal chrome; dismiss
// on backdrop, Esc, or the button.
export function AboutDialog(props: { onClose: () => void; onOpenUrl: (url: string) => void }) {
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
