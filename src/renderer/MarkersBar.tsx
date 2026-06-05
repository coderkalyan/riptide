import { For } from "solid-js";
import { Plus, X } from "lucide-solid";
import { useAppStore } from "./store/store";
import { EditableNum } from "./EditableNum";
import { markerColorCss } from "./wave/palette";
import { formatTime, formatClockWhole, clockCycleOf, clockCycleToTick } from "./wave/format";

// Markers sub-bar: add-at-cursor, plus a horizontally-scrolling list of pills.
// Each pill toggles selection, edits its time inline (ns, or cycle index in
// clock-anchor mode), and deletes.
export function MarkersBar() {
  const s = useAppStore();
  // Clock-aligned editing only when a valid timebase grid exists.
  const clockMode = () => s.clockAnchor && s.clockGrid != null && s.clockGrid.valid;
  const applyMarkerTick = (id: number, n: number): boolean => {
    if (!isFinite(n) || n < 0) return false;
    s.setMarkerTick(id, n);
    return true;
  };

  return (
    <div class="col-sub">
      <span class="sub-label">MARKERS</span>
      <span class="btn sm icon" data-tip="add marker at cursor" onClick={() => s.addMarkerAtCursor()}><Plus size={12} /></span>
      <div class="marker-pills">
        <For each={s.markers}>{(m) => (
          <span
            classList={{ "marker-pill": true, on: m.id === s.selectedMarkerId }}
            style={{ "--mk": markerColorCss(m.color) }}
            data-tip={m.id === s.selectedMarkerId ? "click to deselect" : "click to select"}
            onClick={() => s.selectMarker(s.selectedMarkerId === m.id ? null : m.id)}
          >
            <span>
              {m.name} ·{" "}
              <span data-tip="edit marker time" onClick={(e) => e.stopPropagation()}>
                {clockMode() ? (
                  <EditableNum
                    value={m.tick}
                    editValue={clockCycleOf(m.tick, s.clockGrid!)}
                    format={(t) => formatClockWhole(t, s.clockGrid!)}
                    onCommit={(n) => applyMarkerTick(m.id, clockCycleToTick(n, s.clockGrid!))}
                  />
                ) : (
                  <EditableNum value={m.tick} format={formatTime} onCommit={(n) => applyMarkerTick(m.id, n)} />
                )}
              </span>
              {clockMode() ? null : <>{" "}ns</>}
            </span>
            <span class="rm" data-tip="delete marker" onClick={(e) => { e.stopPropagation(); s.deleteMarker(m.id); }}>
              <X size={10} />
            </span>
          </span>
        )}</For>
      </div>
    </div>
  );
}
