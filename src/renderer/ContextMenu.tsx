import { For, createSignal, onMount, onCleanup } from "solid-js";
import { Portal } from "solid-js/web";

export type MenuItem =
  | { label: string; kbd?: string; disabled?: boolean; submenu?: MenuItem[]; action?: string; path?: string; checked?: boolean }
  | "sep";

// Mock right-click menu for active-signal rows. Only "Remove from View" is wired;
// the rest just close (visual parity with the React build).
export const ACTIVE_SIGNAL_MENU: MenuItem[] = [
  { label: "Set Radix", disabled: true },
  { label: "Change Color…" },
  "sep",
  { label: "Group with Selected", disabled: true },
  { label: "Insert Divider", disabled: true },
  "sep",
  { label: "Move to Top" },
  { label: "Move to Bottom" },
  "sep",
  { label: "Remove from View" },
];

export function ContextMenu(props: {
  x: number; y: number; items: MenuItem[];
  onClose: () => void; onSelect?: (label: string) => void;
}) {
  // Mount hidden, flip `show` next frame so the opacity transition runs.
  const [show, setShow] = createSignal(false);
  onMount(() => {
    const r = requestAnimationFrame(() => setShow(true));
    const onDown = (e: MouseEvent) => { if (!(e.target as HTMLElement).closest(".menu-pop")) props.onClose(); };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") props.onClose(); };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    window.addEventListener("blur", props.onClose);
    onCleanup(() => {
      cancelAnimationFrame(r);
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("blur", props.onClose);
    });
  });

  return (
    <Portal>
      <div class={`menu-pop${show() ? " show" : ""}`} style={{ left: `${props.x}px`, top: `${props.y}px` }}>
        <For each={props.items}>{(it) => it === "sep"
          ? <div class="menu-sep" />
          : (
            <div
              class={`menu-item${it.disabled ? " disabled" : ""}`}
              onClick={() => { if (it.disabled) return; props.onSelect?.(it.label); props.onClose(); }}
            >
              <span>{it.label}</span>
              {it.kbd && <span class="menu-kbd">{it.kbd}</span>}
            </div>
          )}</For>
      </div>
    </Portal>
  );
}
