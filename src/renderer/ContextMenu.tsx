import { For, createSignal, createMemo, createEffect, onMount, onCleanup } from "solid-js";
import { Portal, Dynamic } from "solid-js/web";
import type { JSX } from "solid-js";
import { ArrowUp, ArrowDown, ArrowUpDown } from "lucide-solid";
import { DEFAULT_CLOCK_CONFIG, type ClockPolarity } from "./hier/scene";
import { useAppStore } from "./store/store";
import { EditableNum } from "./EditableNum";

export type MenuItem =
  | { label: string; kbd?: string; disabled?: boolean; unimplemented?: boolean; submenu?: MenuItem[]; action?: string; path?: string; checked?: boolean; gear?: boolean; accessory?: JSX.Element }
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
        data-tip={`polarity: ${cfg().polarity} (click to cycle)`}
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

// Right-click menu for an active-signal row (or the whole selection — the menu
// applies to every selected row). Binary collapses a value to a single line, which
// only makes sense for a 1-bit signal; Signed Decimal only for a multi-bit one. With
// a multi-row target, enablement is ANY across the set: Binary stays enabled if any
// target is 1-bit, Signed Decimal if any is multi-bit (the action then applies only
// to the rows it fits). `anySingleBit`/`anyMultiBit` carry that across the selection.
export function activeSignalMenu(opts: { anyMultiBit: boolean; anySingleBit: boolean; clockRow: number; color?: string; currentFormat?: string }): MenuItem[] {
  // Tick the one format whose action matches the row's current radix/role.
  const fmt = (it: Exclude<MenuItem, "sep">): MenuItem => ({ ...it, checked: it.action === opts.currentFormat });
  return [
    { label: "Format", submenu: [
      fmt({ label: "Binary", action: "radix-bin", disabled: !opts.anySingleBit }),
      fmt({ label: "Clock", action: "format-clock", accessory: <ClockAccessory row={opts.clockRow} /> }),
      fmt({ label: "Reset", action: "format-reset" }),
      "sep",
      fmt({ label: "Signed Decimal", action: "radix-sdec", disabled: !opts.anyMultiBit }),
      fmt({ label: "Unsigned Decimal", action: "radix-dec" }),
      fmt({ label: "Hex", action: "radix-hex" }),
      fmt({ label: "Enum", action: "radix-enum", gear: true }),
    ] },
    // No swatch when the target colors are non-uniform (opts.color undefined).
    { label: "Change Color…", accessory: opts.color ? <span class="menu-swatch" style={{ background: opts.color }} /> : undefined },
    "sep",
    { label: "Group with Selected", disabled: true, unimplemented: true },
    { label: "Insert Divider", disabled: true, unimplemented: true },
    "sep",
    { label: "Move to Top" },
    { label: "Move to Bottom" },
    "sep",
    { label: "Dim" },
    { label: "Dim Others" },
    { label: "Remove from View" },
  ];
}

type Leaf = Exclude<MenuItem, "sep">;

// Place a popup of size w×h near (x, y), preferring down-right (top-left at the
// cursor). If it would overflow the bottom/right, flip above/left of the cursor;
// if it fits neither way, clamp inside the viewport. Standard context-menu feel.
function placeMenu(x: number, y: number, w: number, h: number): { left: number; top: number } {
  const m = 6; // viewport margin
  const vw = window.innerWidth, vh = window.innerHeight;
  const left = x + w + m <= vw ? x : (x - w >= m ? x - w : Math.max(m, vw - w - m));
  const top = y + h + m <= vh ? y : (y - h >= m ? y - h : Math.max(m, vh - h - m));
  return { left, top };
}

export function ContextMenu(props: {
  x: number; y: number; items: MenuItem[];
  onClose: () => void; onSelect?: (item: Leaf) => void; onGear?: (item: Leaf) => void;
}) {
  // Mount hidden, flip `show` next frame so the opacity transition runs.
  const [show, setShow] = createSignal(false);
  // Open submenu flyout: anchor rect of the parent row + its child items.
  const [sub, setSub] = createSignal<{ rect: DOMRect; items: MenuItem[] } | null>(null);
  // Adjusted positions (measured against the viewport so the menu never clips).
  const [pos, setPos] = createSignal({ left: props.x, top: props.y });
  const [subPos, setSubPos] = createSignal({ left: 0, top: 0 });
  let popEl!: HTMLDivElement;
  let subEl!: HTMLDivElement;

  // Re-place the submenu when it opens: prefer the right of its parent row, flip to
  // the left when it would overflow, and keep it vertically inside the viewport.
  createEffect(() => {
    const sb = sub();
    if (!sb) return;
    requestAnimationFrame(() => {
      if (!subEl) return;
      const m = 6, vw = window.innerWidth, vh = window.innerHeight;
      const w = subEl.offsetWidth, h = subEl.offsetHeight;
      const left = sb.rect.right - 4 + w + m <= vw ? sb.rect.right - 4 : Math.max(m, sb.rect.left - w + 4);
      const top = Math.max(m, Math.min(sb.rect.top - 6, vh - h - m));
      setSubPos({ left, top });
    });
  });

  onMount(() => {
    const r = requestAnimationFrame(() => {
      if (popEl) setPos(placeMenu(props.x, props.y, popEl.offsetWidth, popEl.offsetHeight));
      setShow(true);
    });
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
        class={`menu-item${it.disabled ? " disabled" : ""}${it.unimplemented ? " unimplemented" : ""}${!isSub && it.submenu && sub() ? " active" : ""}`}
        onClick={() => select(it)}
        onMouseEnter={(e) => {
          if (isSub) return;
          if (it.submenu) {
            const rect = e.currentTarget.getBoundingClientRect();
            setSub({ rect, items: it.submenu });
            setSubPos({ left: rect.right - 4, top: rect.top - 6 }); // initial guess; effect refines
          }
          else setSub(null);
        }}
      >
        <span class="menu-label"><span class="menu-check">{it.checked ? "✓" : ""}</span>{it.label}</span>
        <span class="menu-end">
          {it.accessory}
          {it.submenu ? <span class="menu-arrow">›</span>
            : it.gear ? (
              <span
                class="menu-gear"
                data-tip="configure enum"
                onClick={(e) => { e.stopPropagation(); props.onGear?.(it); props.onClose(); }}
              >⚙</span>
            )
            : it.kbd ? <span class="menu-kbd">{it.kbd}</span> : null}
        </span>
      </div>
    );

  return (
    <Portal>
      <div ref={popEl} class={`menu-pop${show() ? " show" : ""}`} style={{ left: `${pos().left}px`, top: `${pos().top}px` }}>
        <For each={props.items}>{(it) => renderItem(it, false)}</For>
      </div>
      <div
        ref={subEl}
        class={`menu-pop${show() && sub() ? " show" : ""}`}
        style={{ left: `${subPos().left}px`, top: `${subPos().top}px` }}
      >
        <For each={sub()?.items ?? []}>{(it) => renderItem(it, true)}</For>
      </div>
    </Portal>
  );
}
