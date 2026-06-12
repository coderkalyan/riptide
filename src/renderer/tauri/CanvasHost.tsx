import { onCleanup, onMount } from "solid-js";
import * as bridge from "../ipc/bridge";
import type { InputEvent, KeyCode } from "../ipc/types";

// The Tauri replacement for wave/WaveCanvas.tsx: a TRANSPARENT hole in the DOM
// chrome that the Rust/wgpu renderer draws beneath (the webview composites the
// SolidJS chrome on top). No GPU init, no rAF loop — it only:
//   - forwards pointer / wheel / canvas-keybinding input to Rust (bridge.input),
//   - reports its CSS size + DPR (bridge.resize) via ResizeObserver + the
//     re-armed dppx matchMedia pattern (copied from WaveCanvas.tsx).
// scripts/build-ui.mjs (RIPTIDE_TAURI=1) aliases "./wave/WaveCanvas" to this
// module, so App.tsx's `import { WaveCanvas }` lands here unchanged.
//
// Transparency: in the Electron build the canvas region is painted by a chain
// of opaque backgrounds — html/body (--bg), .app (panel) and .wv-canvas/#gpu
// (panel). For the wgpu surface to show through, every ancestor covering the
// hole must not paint, so the injected stylesheet below clears html/body/.app/
// .wv-canvas and instead gives the NON-wave chrome explicit backgrounds:
//   - .body > .col:not(.waves)  → var(--panel)  (signal tree + active signals;
//     they previously inherited .app's panel background)
//   - .empty-state              → var(--panel)  (idle, no-trace screen)
// Everything else over the window already paints its own background
// (.titlebar/.col-head/.col-sub/.status are --panel-2/--panel; menus, pickers
// and tooltips are opaque portals), so they keep occluding the surface where
// they should.
const TAURI_TRANSPARENCY_CSS = `
html, body, .app, .wv-canvas { background: transparent !important; }
.body > .col:not(.waves) { background: var(--panel); }
.empty-state { background: var(--panel); }
`;

function injectTransparencyCss(): void {
  const ID = "riptide-tauri-transparency";
  if (document.getElementById(ID)) return;
  const el = document.createElement("style");
  el.id = ID;
  el.textContent = TAURI_TRANSPARENCY_CSS;
  document.head.appendChild(el);
}

export function CanvasHost() {
  let host!: HTMLDivElement;

  onMount(() => {
    injectTransparencyCss();

    const send = (ev: InputEvent) => {
      void bridge.input(ev).catch((e) => console.warn("[tauri] input failed", e));
    };
    // Coordinates are CSS px relative to the hole's top-left (the contract's
    // canvas-region origin).
    const pos = (e: { clientX: number; clientY: number }) => {
      const r = host.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    };

    const onPointerDown = (e: PointerEvent) => {
      // Capture so drags (cursor scrub, marker drag) keep streaming moves after
      // the pointer exits the hole — same as the Electron host.
      host.setPointerCapture(e.pointerId);
      const { x, y } = pos(e);
      send({ type: "pointerDown", x, y, button: e.button, buttons: e.buttons, ctrl: e.ctrlKey, shift: e.shiftKey });
    };
    const onPointerMove = (e: PointerEvent) => {
      const { x, y } = pos(e);
      send({ type: "pointerMove", x, y, buttons: e.buttons });
    };
    const onPointerUp = (e: PointerEvent) => {
      if (host.hasPointerCapture(e.pointerId)) host.releasePointerCapture(e.pointerId);
      const { x, y } = pos(e);
      send({ type: "pointerUp", x, y, button: e.button, buttons: e.buttons });
    };
    const onPointerLeave = () => send({ type: "pointerLeave" });
    const onWheel = (e: WheelEvent) => {
      e.preventDefault(); // pan/zoom is Rust's; never scroll the page
      const { x, y } = pos(e);
      send({ type: "wheel", x, y, dx: e.deltaX, dy: e.deltaY, ctrl: e.ctrlKey, shift: e.shiftKey });
    };

    // Canvas keybindings → contract KeyCodes. Mirrors WaveCanvas.tsx's onKey
    // (m / Delete / Backspace / [ / ]) plus App.tsx's Ctrl zoom shortcuts
    // (Ctrl+=/+, Ctrl+-, Ctrl+0). "undoView" has no Electron binding yet, so
    // nothing maps to it here. Same input-field bail as the Electron handler.
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable)) return;
      let code: KeyCode | null = null;
      let prevent = false;
      if (e.ctrlKey && !e.altKey) {
        const k = e.key.toLowerCase();
        if (k === "=" || k === "+") { code = "zoomIn"; prevent = true; }
        else if (k === "-" || k === "_") { code = "zoomOut"; prevent = true; }
        else if (k === "0") { code = "zoomFit"; prevent = true; }
      } else if (!e.ctrlKey && !e.metaKey && !e.altKey) {
        if (e.key === "m" || e.key === "M") code = "addMarker";
        else if (e.key === "Delete" || e.key === "Backspace") code = "deleteMarker";
        else if (e.key === "]") code = "nextMarker";
        else if (e.key === "[") code = "prevMarker";
      }
      if (code == null) return;
      if (prevent) e.preventDefault();
      send({ type: "key", code, ctrl: e.ctrlKey, shift: e.shiftKey, alt: e.altKey });
    };

    const report = () => {
      void bridge
        .resize(host.clientWidth, host.clientHeight, window.devicePixelRatio || 1)
        .catch((e) => console.warn("[tauri] resize failed", e));
    };
    const ro = new ResizeObserver(report);
    ro.observe(host);
    report();
    // DPR-only changes (dragging between displays) don't fire ResizeObserver;
    // watch via matchMedia and re-arm each fire (same pattern as WaveCanvas).
    let dprMql = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
    const onDprChange = () => {
      report();
      dprMql.removeEventListener("change", onDprChange);
      dprMql = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
      dprMql.addEventListener("change", onDprChange);
    };
    dprMql.addEventListener("change", onDprChange);

    host.addEventListener("wheel", onWheel, { passive: false });
    host.addEventListener("pointerdown", onPointerDown);
    host.addEventListener("pointermove", onPointerMove);
    host.addEventListener("pointerup", onPointerUp);
    host.addEventListener("pointercancel", onPointerUp);
    host.addEventListener("pointerleave", onPointerLeave);
    window.addEventListener("keydown", onKey);

    onCleanup(() => {
      ro.disconnect();
      dprMql.removeEventListener("change", onDprChange);
      host.removeEventListener("wheel", onWheel);
      host.removeEventListener("pointerdown", onPointerDown);
      host.removeEventListener("pointermove", onPointerMove);
      host.removeEventListener("pointerup", onPointerUp);
      host.removeEventListener("pointercancel", onPointerUp);
      host.removeEventListener("pointerleave", onPointerLeave);
      window.removeEventListener("keydown", onKey);
    });
  });

  // .gpu-host gives the crosshair cursor + fills .wv-canvas; no canvas inside —
  // the div stays unpainted so the wgpu surface shows through.
  return <div class="gpu-host" ref={host} />;
}

// The tauri build aliases "./wave/WaveCanvas" to this file (build-ui.mjs), so
// App.tsx's named import resolves to the host.
export { CanvasHost as WaveCanvas };
