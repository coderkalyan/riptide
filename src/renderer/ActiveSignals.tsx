import { For, Show, createMemo } from "solid-js";
import { PanelLeftClose, PanelLeftOpen } from "lucide-solid";
import { getSignal } from "./hier/hierarchy";
import { SCENE, type ActiveSignalRef } from "./hier/scene";
import { useAppStore } from "./store/store";
import { ActiveSignal, type ActiveSignalKind } from "./ActiveSignal";
import { valueAtTick, formatSegmentValue } from "./wave/value";

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
  return (
    <div class="col">
      <div class="col-head" style={{ "padding-right": "3px" }}>
        <h3>Active Signals</h3>
        <span class="sp" style={{ flex: 1 }} />
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
        <input class="search" placeholder={props.collapsed ? "filter signals" : "filter active signals"} />
      </div>
      <Show
        when={props.collapsed}
        fallback={<div class="s-head"><span /><span /><span>Name</span><span>Value</span><span /></div>}
      >
        <div class="s-head"><span style={{ "font-weight": 700 }}>Name</span></div>
      </Show>
      <div
        class="signals"
        onContextMenu={(e) => { e.preventDefault(); s.setCtxMenu({ x: e.clientX, y: e.clientY, row: -1 }); }}
        onClick={(e) => { if (e.target === e.currentTarget) s.clearSelection(); }}
      >
        <For each={s.activeSignals}>{(row) => {
          const sig = getSignal(SCENE.hierarchy, row.signalId);
          const value = createMemo(() =>
            formatSegmentValue(valueAtTick(sig.handle, s.cursorTicks), sig.bitWidth, row.radix, props.enumLabels().get(row.row)));
          return (
            <ActiveSignal
              name={sig.name}
              kind={activeSignalKind(row)}
              color={row.color}
              selected={row.selected}
              hidden={row.hidden}
              collapsed={props.collapsed}
              sliding={props.sliding}
              value={value()}
              onPinClick={(e) => s.setPicker({ row: row.row, anchorRect: (e.currentTarget as HTMLElement).getBoundingClientRect() })}
              onToggleVisible={() => s.toggleHidden(row.row)}
              onClick={() => s.selectRow(row.row)}
              onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); s.setCtxMenu({ x: e.clientX, y: e.clientY, row: row.row }); }}
            />
          );
        }}</For>
      </div>
    </div>
  );
}
