import { For, createSignal, createEffect, onCleanup } from "solid-js";
import { Portal } from "solid-js/web";
import type { MenuItem } from "./ContextMenu";

// Mock menubar dropdowns. Items are representative only — clicking just closes
// the menu (except "Open VCD…", which fires onOpenVcd).
const MENUS: { name: string; items: MenuItem[] }[] = [
  { name: "File", items: [
    { label: "New Window", kbd: "⌘N" }, { label: "Open VCD…", kbd: "⌘O" }, { label: "Open Recent" }, "sep",
    { label: "Reload Trace", kbd: "⌘R" }, { label: "Export Image…" }, "sep", { label: "Close Window", kbd: "⌘W" },
  ] },
  { name: "Edit", items: [
    { label: "Undo", kbd: "⌘Z" }, { label: "Redo", kbd: "⇧⌘Z" }, "sep",
    { label: "Cut", kbd: "⌘X" }, { label: "Copy", kbd: "⌘C" }, { label: "Paste", kbd: "⌘V" }, "sep", { label: "Find…", kbd: "⌘F" },
  ] },
  { name: "View", items: [
    { label: "Zoom In", kbd: "⌘+" }, { label: "Zoom Out", kbd: "⌘−" }, { label: "Zoom to Fit", kbd: "⌘0" }, "sep",
    { label: "Toggle Signal Tree" }, { label: "Toggle Active Signals" }, "sep", { label: "Reset Layout" },
  ] },
  { name: "Signals", items: [
    { label: "Add Signal…", kbd: "⌘⏎" }, { label: "Group Selected" }, { label: "Remove from View" }, "sep",
    { label: "Set Radix" }, { label: "Change Color…" },
  ] },
  { name: "Markers", items: [
    { label: "Add Marker", kbd: "M" }, { label: "Delete Marker", kbd: "⌫" }, { label: "Clear All Markers" }, "sep",
    { label: "Next Marker", kbd: "]" }, { label: "Previous Marker", kbd: "[" },
  ] },
  { name: "Window", items: [{ label: "Minimize", kbd: "⌘M" }, { label: "Zoom" }, "sep", { label: "Bring All to Front" }] },
  { name: "Help", items: [{ label: "Documentation" }, { label: "Keyboard Shortcuts", kbd: "⌘/" }, "sep", { label: "About Riptide" }] },
];

export function MenuBar(props: { onOpenVcd: () => void }) {
  const [open, setOpen] = createSignal<{ name: string; rect: DOMRect } | null>(null);
  // Frozen snapshot of the last-open menu — stays mounted while `open` is null so
  // the popup can fade out.
  const [pop, setPop] = createSignal<{ rect: DOMRect; items: MenuItem[] } | null>(null);

  createEffect(() => {
    const o = open();
    if (!o) return;
    const menu = MENUS.find((m) => m.name === o.name);
    if (menu) setPop({ rect: o.rect, items: menu.items });
  });
  createEffect(() => {
    if (!open()) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as HTMLElement;
      if (!t.closest(".menubar") && !t.closest(".menu-pop")) setOpen(null);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(null); };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    onCleanup(() => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    });
  });

  return (
    <div class="menubar">
      <For each={MENUS}>{(m) => (
        <span
          class={`m${open()?.name === m.name ? " open" : ""}`}
          onClick={(e) => {
            const rect = e.currentTarget.getBoundingClientRect();
            setOpen((o) => (o?.name === m.name ? null : { name: m.name, rect }));
          }}
          onMouseEnter={(e) => { if (open()) setOpen({ name: m.name, rect: e.currentTarget.getBoundingClientRect() }); }}
        >{m.name}</span>
      )}</For>
      <Portal>
        <div
          class={`menu-pop${open() ? " show" : ""}`}
          style={{ left: `${pop()?.rect.left ?? 0}px`, top: `${(pop()?.rect.bottom ?? 0) + 4}px` }}
        >
          <For each={pop()?.items ?? []}>{(it) => it === "sep"
            ? <div class="menu-sep" />
            : (
              <div class="menu-item" onClick={() => { setOpen(null); if (it.label === "Open VCD…") props.onOpenVcd(); }}>
                <span>{it.label}</span>
                {it.kbd && <span class="menu-kbd">{it.kbd}</span>}
              </div>
            )}</For>
        </div>
      </Portal>
    </div>
  );
}
