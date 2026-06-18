import { For, Index, Show, createMemo } from "solid-js";
import { PanelLeftClose, PanelLeftOpen, Eye, EyeOff } from "lucide-solid";
import { getSignal } from "./hier/hierarchy";
import { SCENE, type ActiveSignalRef } from "./hier/scene";
import { useAppStore, type DividerTarget } from "./store/store";
import { ActiveSignal, type ActiveSignalKind } from "./ActiveSignal";
import { makeHoverArm } from "./hoverArm";
import { valueAtTick, formatSegmentValue } from "./wave/value";
import {
  ROW_HEIGHT_CSS, ROW_MIN_HEIGHT_CSS, ROW_MAX_HEIGHT_CSS,
  DIVIDER_HEIGHT_CSS, DIVIDER_MIN_HEIGHT_CSS, DIVIDER_MAX_HEIGHT_CSS,
} from "./wave/constants";

// Icon reflects the chosen format: clock and reset get their own glyph, every
// other format (binary/decimal/hex/enum) shows the generic data icon.
function activeSignalKind(ref: ActiveSignalRef): ActiveSignalKind {
  if (ref.role === "clock") return "clock";
  if (ref.role === "reset") return "reset";
  return "signal";
}

// The Active Signals column: header (full vs compact) + filter + rows. Each
// row's value cell is a per-row createMemo on cursorTicks/radix/enumLabels — so a
// cursor move recomputes only the value cells, and a color/select edit nothing.
export function ActiveSignals(props: {
  enumLabels: () => Map<number, Map<number, string>>;
  collapsed: boolean;
  sliding: boolean;
  onToggleCollapse: (collapsed: boolean) => void;
}) {
  const s = useAppStore();
  // Drag the row's bottom handle to resize its height; pointer capture keeps the
  // drag alive past the thin handle. Persists via setRowHeight (sidecar autosave);
  // the canvas re-applies the GPU row layout through its cosmetic subscription.
  // Shared bottom-handle drag: tracks pointer Y, clamps, and writes the new height
  // via `apply`. Used by both signal rows and divider entries.
  const startVResize = (startH: number, min: number, max: number, apply: (h: number) => void) => (e: PointerEvent) => {
    e.preventDefault();
    const startY = e.clientY;
    const target = e.currentTarget as HTMLElement;
    target.setPointerCapture(e.pointerId);
    const onMove = (ev: PointerEvent) => apply(Math.max(min, Math.min(max, startH + (ev.clientY - startY))));
    const onUp = (ev: PointerEvent) => {
      target.releasePointerCapture(ev.pointerId);
      target.removeEventListener("pointermove", onMove);
      target.removeEventListener("pointerup", onUp);
    };
    target.addEventListener("pointermove", onMove);
    target.addEventListener("pointerup", onUp);
  };
  const startRowResize = (row: number, current: number | undefined) =>
    startVResize(current ?? ROW_HEIGHT_CSS, ROW_MIN_HEIGHT_CSS, ROW_MAX_HEIGHT_CSS, (h) => s.setRowHeight(row, h));
  const startDividerResize = (t: DividerTarget, current: number) =>
    startVResize(current || DIVIDER_HEIGHT_CSS, DIVIDER_MIN_HEIGHT_CSS, DIVIDER_MAX_HEIGHT_CSS, (h) => s.setDividerHeight(t, h));
  // One divider (separator) row. `h` is its live height accessor (0 = default).
  // Resize drags the bottom handle; right-click removes it via its own menu.
  const renderDivider = (t: DividerTarget, h: () => number) => {
    const arm = makeHoverArm((e) => { e.stopPropagation(); startDividerResize(t, h())(e); });
    return (
      <div
        class="s-divider"
        style={h() ? { height: `${h()}px` } : undefined}
        onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); s.setCtxMenu({ x: e.clientX, y: e.clientY, row: -1, kind: "divider", div: t }); }}
      >
        <span
          class="s-resize"
          onPointerEnter={arm.onPointerEnter}
          onPointerLeave={arm.onPointerLeave}
          onPointerDown={arm.onPointerDown}
          onDblClick={(e) => { e.stopPropagation(); s.setDividerHeight(t, undefined); }}
          onClick={(e) => e.stopPropagation()}
        />
      </div>
    );
  };
  return (
    <div class="col">
      <div class="col-head tw:pr-[3px]">
        <h3>Active Signals</h3>
        <span class="sp" />
        {/* Hint held back during the expand slide so a resize won't flicker it. */}
        <Show when={!props.collapsed && !props.sliding}>
          <span class="hint">{s.activeSignals.length} active</span>
        </Show>
        <span
          class="collapse"
          data-tip={props.collapsed ? "full view" : "compact view"}
          onClick={() => props.onToggleCollapse(!props.collapsed)}
        >
          {props.collapsed ? <PanelLeftOpen size={14} stroke-width={1.75} /> : <PanelLeftClose size={14} stroke-width={1.75} />}
        </span>
      </div>
      <div class="col-sub">
        {/* Filtering isn't wired up yet — disabled so it doesn't read as a working control. */}
        <input class="search" placeholder={props.collapsed ? "filter signals" : "filter active signals"} disabled data-tip="filtering not yet implemented" />
      </div>
      <Show
        when={props.collapsed}
        fallback={
          <div class="s-head">
            <span /><span /><span class="h-name">Name</span><span class="h-val">Value</span>
            {(() => {
              const anyDimmed = () => s.activeSignals.some((r) => r.hidden);
              return (
                <span
                  class={"eye head" + (anyDimmed() ? " off" : "")}
                  data-tip={anyDimmed() ? "show all signals" : "dim all signals"}
                  onClick={() => s.toggleAllHidden()}
                >
                  {anyDimmed() ? <EyeOff size={12} /> : <Eye size={12} />}
                </span>
              );
            })()}
          </div>
        }
      >
        <div class="s-head"><span class="h-name">Name</span></div>
      </Show>
      <div
        class="signals"
        // Right-click on the empty area below the rows → add a divider at the bottom.
        onContextMenu={(e) => { e.preventDefault(); if (e.target === e.currentTarget) s.setCtxMenu({ x: e.clientX, y: e.clientY, row: -1, kind: "pane" }); }}
        onClick={(e) => { if (e.target === e.currentTarget) s.clearSelection(); }}
      >
        {/* Top-gap dividers (above the first row). */}
        <Index each={s.topDividers}>{(h, i) => renderDivider({ row: -1, index: i }, h)}</Index>
        <For each={s.activeSignals}>{(row) => {
          const sig = getSignal(SCENE.hierarchy, row.signalId);
          const value = createMemo(() =>
            formatSegmentValue(valueAtTick(sig.handle, s.cursorTicks), sig.bitWidth, row.radix, props.enumLabels().get(row.row)));
          return (
            <>
              <ActiveSignal
                name={sig.name}
                kind={activeSignalKind(row)}
                color={row.color}
                selected={row.selected || s.ctxMenu?.row === row.row}
                hidden={row.hidden}
                collapsed={props.collapsed}
                sliding={props.sliding}
                value={value()}
                height={row.height}
                onPinClick={(e) => s.setPicker({ row: row.row, anchorRect: (e.currentTarget as HTMLElement).getBoundingClientRect() })}
                onToggleVisible={() => s.toggleHidden(row.row)}
                onClick={(e) => s.selectRow(row.row, { ctrl: e.ctrlKey || e.metaKey, shift: e.shiftKey })}
                onContextMenu={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  // No persistent selection change — the ctxMenu row is highlighted
                  // transiently (see `selected` above + WaveCanvas) only while the menu
                  // is open, so a lone right-click shows the row as active.
                  s.setCtxMenu({ x: e.clientX, y: e.clientY, row: row.row });
                }}
                onResizeStart={startRowResize(row.row, row.height)}
                onResizeReset={() => s.setRowHeight(row.row, undefined)}
              />
              {/* Dividers below this row (back-to-back allowed). */}
              <Index each={row.dividers ?? []}>{(h, i) => renderDivider({ row: row.row, index: i }, h)}</Index>
            </>
          );
        }}</For>
      </div>
    </div>
  );
}
