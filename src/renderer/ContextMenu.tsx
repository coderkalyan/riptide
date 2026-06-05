import { For, createSignal, createMemo, onMount, onCleanup } from "solid-js";
import { Portal, Dynamic } from "solid-js/web";
import type { JSX } from "solid-js";
import { ArrowUp, ArrowDown, ArrowUpDown } from "lucide-solid";
import { DEFAULT_CLOCK_CONFIG, type ClockPolarity } from "./hier/scene";
import { useAppStore } from "./store/store";
import { EditableNum } from "./EditableNum";

export type MenuItem =
  | { label: string; kbd?: string; disabled?: boolean; submenu?: MenuItem[]; action?: string; path?: string; checked?: boolean; gear?: boolean; accessory?: JSX.Element }
  | "sep";

const POLARITY_ICON = { rising: ArrowUp, falling: ArrowDown, both: ArrowUpDown } as const;
const NEXT_POLARITY: Record<ClockPolarity, ClockPolarity> = { rising: "falling", falling: "both", both: "rising" };

// Inline clock config on the Clock format item: a clickable polarity glyph that
// cycles rising → falling → both, and an editable period ("10 ns"). Live-reads the
// row's clock config so edits reflect immediately; both controls stop click
// propagation so they don't trigger the item's format-select or close the menu.
function ClockAccessory(props: { row: number }) {
  const s = useAppStore();
  const cfg = createMemo(() => s.activeSignals.find((r) => r.row === props.row)?.clock ?? DEFAULT_CLOCK_CONFIG);
  return (
    <span class="menu-clock-info" onClick={(e) => e.stopPropagation()}>
      <span
        class="menu-clock-pol"
        title={`polarity: ${cfg().polarity} (click to cycle)`}
        onClick={(e) => { e.stopPropagation(); s.setClockConfig(props.row, { ...cfg(), polarity: NEXT_POLARITY[cfg().polarity] }); }}
      >
        <Dynamic component={POLARITY_ICON[cfg().polarity]} size={12} />
      </span>
      <EditableNum
        value={cfg().period}
        format={(n) => `${n}`}
        onCommit={(n) => { if (!Number.isFinite(n) || n <= 0) return false; s.setClockConfig(props.row, { ...cfg(), period: n }); return true; }}
      />
      <span class="menu-clock-unit">ns</span>
    </span>
  );
}

// Right-click menu for an active-signal row. Binary collapses a value to a single
// line, which only makes sense for a 1-bit signal — so it's disabled for multi-bit
// signals (all other formats stay available); 1-bit signals allow every format.
export function activeSignalMenu(opts: { multiBit: boolean; clockRow: number; color?: string }): MenuItem[] {
  return [
    { label: "Format", submenu: [
      { label: "Binary", action: "radix-bin", disabled: opts.multiBit },
      { label: "Clock", action: "format-clock", accessory: <ClockAccessory row={opts.clockRow} /> },
      { label: "Reset", action: "format-reset" },
      "sep",
      { label: "Signed Decimal", action: "radix-sdec", disabled: !opts.multiBit },
      { label: "Unsigned Decimal", action: "radix-dec" },
      { label: "Hex", action: "radix-hex" },
      { label: "Enum", action: "radix-enum", gear: true },
    ] },
    { label: "Change Color…", accessory: <span class="menu-swatch" style={{ background: opts.color ?? "var(--muted)" }} /> },
    "sep",
    { label: "Group with Selected", disabled: true },
    { label: "Insert Divider", disabled: true },
    "sep",
    { label: "Move to Top" },
    { label: "Move to Bottom" },
    "sep",
    { label: "Remove from View" },
  ];
}

type Leaf = Exclude<MenuItem, "sep">;

export function ContextMenu(props: {
  x: number; y: number; items: MenuItem[];
  onClose: () => void; onSelect?: (item: Leaf) => void; onGear?: (item: Leaf) => void;
}) {
  // Mount hidden, flip `show` next frame so the opacity transition runs.
  const [show, setShow] = createSignal(false);
  // Open submenu flyout: anchor rect of the parent row + its child items.
  const [sub, setSub] = createSignal<{ rect: DOMRect; items: MenuItem[] } | null>(null);
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

  const select = (it: Leaf) => { if (it.disabled || it.submenu) return; props.onSelect?.(it); props.onClose(); };

  const renderItem = (it: MenuItem, isSub: boolean) => it === "sep"
    ? <div class="menu-sep" />
    : (
      <div
        class={`menu-item${it.disabled ? " disabled" : ""}${!isSub && it.submenu && sub() ? " active" : ""}`}
        onClick={() => select(it)}
        onMouseEnter={(e) => {
          if (isSub) return;
          if (it.submenu) setSub({ rect: e.currentTarget.getBoundingClientRect(), items: it.submenu });
          else setSub(null);
        }}
      >
        <span>{it.label}</span>
        <span class="menu-end">
          {it.accessory}
          {it.submenu ? <span class="menu-arrow">›</span>
            : it.gear ? (
              <span
                class="menu-gear"
                title="Configure…"
                onClick={(e) => { e.stopPropagation(); props.onGear?.(it); props.onClose(); }}
              >⚙</span>
            )
            : it.kbd ? <span class="menu-kbd">{it.kbd}</span> : null}
        </span>
      </div>
    );

  return (
    <Portal>
      <div class={`menu-pop${show() ? " show" : ""}`} style={{ left: `${props.x}px`, top: `${props.y}px` }}>
        <For each={props.items}>{(it) => renderItem(it, false)}</For>
      </div>
      <div
        class={`menu-pop${show() && sub() ? " show" : ""}`}
        style={{ left: `${(sub()?.rect.right ?? 0) - 4}px`, top: `${(sub()?.rect.top ?? 0) - 6}px` }}
      >
        <For each={sub()?.items ?? []}>{(it) => renderItem(it, true)}</For>
      </div>
    </Portal>
  );
}
