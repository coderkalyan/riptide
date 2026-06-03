import { For, createMemo } from "solid-js";
import { getSignal } from "../renderer/hier/hierarchy";
import { SCENE, type ActiveSignalRef } from "../renderer/hier/scene";
import { useAppStore } from "./store/store";
import { ActiveSignal, type ActiveSignalKind } from "./ActiveSignal";
import { valueAtTick, formatSegmentValue } from "./wave/value";

function activeSignalKind(ref: ActiveSignalRef): ActiveSignalKind {
  if (ref.role === "clock") return "clock";
  if (ref.role === "reset") return "reset";
  if (ref.role === "valid") return "valid";
  if (ref.derivedExpr) return "derived";
  return "signal";
}

// The Active Signals column: header + filter + rows. Each row's value cell is a
// per-row createMemo on cursorTicks/radix/enumLabels — so a cursor move
// recomputes only the value cells (not the whole panel), and a color/select edit
// recomputes nothing. The structural/cosmetic store edits the rows trigger are
// picked up by the canvas's GPU subscriptions.
export function ActiveSignals(props: { enumLabels: () => Map<number, Map<number, string>> }) {
  const s = useAppStore();
  return (
    <div class="col">
      <div class="col-head">
        <h3>Active Signals</h3>
        <span class="sp" style={{ flex: 1 }} />
        <span class="hint">{s.activeSignals.length} active</span>
      </div>
      <div class="col-sub"><input class="search" placeholder="filter active signals" /></div>
      <div class="s-head"><span /><span /><span>Name</span><span>Value</span><span /></div>
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
