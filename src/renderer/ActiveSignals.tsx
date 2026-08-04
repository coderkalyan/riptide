import { For, Index, Show, createMemo } from "solid-js";
import { PanelLeftClose, PanelLeftOpen, Eye, EyeOff, X } from "lucide-solid";
import { getSignal } from "./hier/hierarchy";
import { SCENE, type ActiveSignalRef } from "./hier/scene";
import { useAppStore, type DividerTarget } from "./store/store";
import { ActiveSignal, type ActiveSignalKind } from "./ActiveSignal";
import { signalTip } from "./hier/describe";
import { makeHoverArm } from "./hoverArm";
import { markStrings } from "./native";
import { clipRanges, type Ranges } from "./highlight";
import {
  dragState, beginDrag, moveDrag, endDrag, cancelDrag, consumeDragClick,
  type DragGeom,
} from "./wave/dragReorder";
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

// The Active Signals column: header (full vs compact) + find box + rows. Each
// row's value cell is a per-row createMemo on cursorTicks/radix/enumLabels — so a
// cursor move recomputes only the value cells, and a color/select edit nothing.
//
// The find box marks matches in place instead of filtering the list down: these
// rows sit one-to-one beside the canvas rows (same order, same heights — see
// wave/constants ROW_HEIGHT_CSS), so dropping any would slide the rest out of
// line with the waveforms they label.
export function ActiveSignals(props: {
  enumLabels: () => Map<number, Map<number, string>>;
  collapsed: boolean;
  sliding: boolean;
  onToggleCollapse: (collapsed: boolean) => void;
}) {
  const s = useAppStore();
  let signalsEl!: HTMLDivElement; // the scrollable .signals container (drag geometry source)

  // The row paths, re-derived only when they actually change. Every row edit
  // (color, selection, height) replaces the activeSignals array, and none of them
  // can change a match — the custom equality keeps those out of the search below.
  const rowPaths = createMemo(() => s.activeSignals.map((r) => r.path), undefined, {
    equals: (a, b) => a.length === b.length && a.every((path, i) => path === b[i]),
  });

  // Row paths matched against the find text, keyed by row index — which is also
  // the row number, since `row` is kept as the contiguous 0..N-1 canvas slot (see
  // the store's renumber). Matching runs over the whole path so a query can name a
  // scope, but only the part of the match landing in the leaf name is highlighted,
  // since that is all a row shows. markStrings rather than the tree's search
  // because a row may be a derived signal, with no hierarchy node behind it.
  const matches = createMemo<Map<number, Ranges> | null>(() => {
    const query = s.activeQuery.trim();
    if (!query) return null;
    const paths = rowPaths();
    const marks = markStrings(paths, query);
    const out = new Map<number, Ranges>();
    for (let row = 0; row < paths.length; row++) {
      if (marks.matched[row]) out.set(row, clipRanges(marks.ranges[row], marks.leafOffsets[row], paths[row].length));
    }
    return out;
  });

  // Press-and-drag a row body to reorder. A plain click (no threshold crossed)
  // still selects; the resize handle / pin / eye are excluded. Geometry is
  // snapshotted once at drag start (before any transform); the reorder commits
  // in one store call on release. See wave/dragReorder.ts + docs/drag-reorder.md.
  const onRowDragStart = (rowId: number) => (e: PointerEvent) => {
    if (e.button !== 0) return;
    if ((e.target as HTMLElement).closest(".s-resize, .pin, .eye")) return;
    const el = e.currentTarget as HTMLElement;
    const startY = e.clientY;
    const pointerId = e.pointerId;
    let started = false;
    let containerTop = 0;       // viewport Y of the container's top edge (fixed during drag)
    let lastClientY = startY;   // for autoscroll-driven re-evaluation
    let autoRaf = 0;
    let autoVel = 0;

    const contentY = (clientY: number) => clientY - containerTop + signalsEl.scrollTop;

    const stopAutoScroll = () => { if (autoRaf) { cancelAnimationFrame(autoRaf); autoRaf = 0; } autoVel = 0; };
    const tickScroll = () => {
      if (!autoVel) { autoRaf = 0; return; }
      const before = signalsEl.scrollTop;
      signalsEl.scrollTop += autoVel;
      if (signalsEl.scrollTop !== before) moveDrag(contentY(lastClientY)); // pointer fixed, content moved
      autoRaf = requestAnimationFrame(tickScroll);
    };
    const armAutoScroll = (clientY: number, top: number, bottom: number) => {
      const EDGE = 28, SPEED = 10;
      autoVel = clientY < top + EDGE ? -SPEED : clientY > bottom - EDGE ? SPEED : 0;
      if (autoVel && !autoRaf) autoRaf = requestAnimationFrame(tickScroll);
      else if (!autoVel) stopAutoScroll();
    };

    const onMove = (ev: PointerEvent) => {
      lastClientY = ev.clientY;
      if (!started) {
        if (Math.abs(ev.clientY - startY) < 5) return; // movement threshold
        const cr = signalsEl.getBoundingClientRect();
        containerTop = cr.top;
        const scroll0 = signalsEl.scrollTop;
        const els = signalsEl.querySelectorAll<HTMLElement>(".s-row"); // DOM order === activeSignals order
        const geom: DragGeom[] = s.activeSignals.map((r, i) => {
          const rc = els[i].getBoundingClientRect();
          return { id: r.id, top: rc.top - cr.top + scroll0, height: rc.height };
        });
        el.setPointerCapture(pointerId);
        beginDrag(rowId, geom);
        started = true;
      }
      moveDrag(contentY(ev.clientY));
      const cr = signalsEl.getBoundingClientRect();
      armAutoScroll(ev.clientY, cr.top, cr.bottom);
    };
    const cleanup = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("keydown", onKey);
      stopAutoScroll();
    };
    const onUp = () => {
      cleanup();
      if (!started) return;
      try { el.releasePointerCapture(pointerId); } catch { /* already released */ }
      const res = endDrag();
      if (res) s.reorderSignal(res.from, res.to);
    };
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key !== "Escape") return;
      cleanup();
      if (started) { try { el.releasePointerCapture(pointerId); } catch { /* */ } cancelDrag(); }
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("keydown", onKey);
  };

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
          <span class="hint">{matches() ? `${matches()!.size} of ${s.activeSignals.length}` : `${s.activeSignals.length} active`}</span>
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
        <input
          class="search"
          placeholder={props.collapsed ? "find signals" : "find active signals"}
          value={s.activeQuery}
          spellcheck={false}
          data-tip="mark matching rows"
          onInput={(ev) => s.setActiveQuery(ev.currentTarget.value)}
          onKeyDown={(ev) => {
            // Enter selects every match, so the row context menu / Signals menu
            // can act on the whole set; Esc clears the search.
            if (ev.key === "Enter") {
              ev.preventDefault();
              const hit = matches();
              if (hit) s.selectRows([...hit.keys()]);
            } else if (ev.key === "Escape" && s.activeQuery) {
              ev.preventDefault();
              s.setActiveQuery("");
            }
          }}
        />
        <Show when={s.activeQuery}>
          <span class="collapse" data-tip="clear" onClick={() => s.setActiveQuery("")}><X size={12} /></span>
        </Show>
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
                  data-tip={anyDimmed() ? "undim all signals" : "dim all signals"}
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
        ref={signalsEl}
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
                tip={signalTip(SCENE.hierarchy, sig)}
                nameRanges={matches()?.get(row.row)}
                unmatched={!!matches() && !matches()!.has(row.row)}
                kind={activeSignalKind(row)}
                color={row.color}
                selected={row.selected || s.ctxMenu?.row === row.row}
                hidden={row.hidden}
                collapsed={props.collapsed}
                sliding={props.sliding}
                value={value()}
                height={row.height}
                dragging={dragState()?.dragId === row.id}
                dragActive={!!dragState()}
                dragTransform={dragState()?.dragId === row.id ? dragState()!.liftY : (dragState()?.offsets.get(row.id) ?? 0)}
                onDragStart={onRowDragStart(row.id)}
                onPinClick={(e) => s.setPicker({ row: row.row, anchorRect: (e.currentTarget as HTMLElement).getBoundingClientRect() })}
                onToggleVisible={() => s.toggleHidden(row.row)}
                onClick={(e) => { if (consumeDragClick()) return; s.selectRow(row.row, { ctrl: e.ctrlKey || e.metaKey, shift: e.shiftKey }); }}
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
