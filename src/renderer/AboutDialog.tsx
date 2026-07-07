import { onMount, onCleanup } from "solid-js";
import { Portal } from "solid-js/web";
import { Waves } from "lucide-solid";

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
export function AboutDialog(props: { onClose: () => void }) {
  onMount(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") props.onClose(); };
    document.addEventListener("keydown", onKey);
    onCleanup(() => document.removeEventListener("keydown", onKey));
  });
  return (
    <Portal>
      <div class="modal-backdrop" onMouseDown={props.onClose}>
        <div class="modal about-modal" onMouseDown={(e) => e.stopPropagation()}>
          <div class="about-mark"><Waves size={28} /></div>
          <div class="about-name">Riptide</div>
          <div class="about-version">Version {pkg.version}</div>
          {pkg.description && <div class="about-desc">{pkg.description}</div>}
          {runtimeLine && <div class="about-meta">{runtimeLine}</div>}
          <div class="about-meta">Copyright © 2026 Kalyan Sriram · Apache-2.0</div>
          <div class="modal-actions">
            <button class="btn primary" onClick={props.onClose}>Close</button>
          </div>
        </div>
      </div>
    </Portal>
  );
}
