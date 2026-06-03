import {
  ArrowLeftToLine, ArrowRightToLine, ChevronFirst, ChevronLast, ChevronLeft, ChevronRight,
  Clock, Grid2x2, Maximize, Minus, Plus,
} from "lucide-solid";
import { SCENE } from "../renderer/hier/scene";
import { useAppStore } from "./store/store";
import { view } from "./wave/viewport";
import { formatTime, formatTimescale } from "./wave/format";
import { ZOOM_STEP } from "./wave/constants";
import { EditableNum } from "./EditableNum";

// Waves toolbar: cursor pill (jump-to-cursor + edit), nav segs (decorative,
// mock — match the React build), editable [start–end] range, zoom in/out/fit,
// snap + clock toggles. Zoom drives the viewport controller; toggles drive the
// store. (The nav/transition buttons have no handlers yet, as in React.)
export function WavesToolbar() {
  const s = useAppStore();
  const applyCursor = (n: number): boolean => {
    if (!isFinite(n) || n < 0) return false;
    s.setCursor(n);
    return true;
  };
  const applyRange = (start: number, end: number): boolean => {
    if (!view.applyRange(start, end)) return false;
    s.setViewRange(view.startTicks, view.startTicks + view.timelinePx * view.ticksPerPixel);
    return true;
  };

  return (
    <div class="col-head toolbar">
      <span class="pill" data-tip="jump to cursor" onClick={() => view.jumpToCursor(s.cursorTicks)}>
        <span class="swatch" />
        <span class="mono">cursor at{" "}
          <span data-tip="edit cursor time" onClick={(e) => e.stopPropagation()}>
            <EditableNum value={s.cursorTicks} format={formatTime} onCommit={applyCursor} />
          </span>{" "}ns
        </span>
      </span>
      <div class="seg">
        <span class="btn icon" data-tip="jump to start"><ChevronFirst size={14} /></span>
        <span class="btn icon" data-tip="step back"><ChevronLeft size={14} /></span>
        <span class="btn icon" data-tip="step forward"><ChevronRight size={14} /></span>
        <span class="btn icon" data-tip="jump to end"><ChevronLast size={14} /></span>
      </div>
      <div class="seg">
        <span class="btn icon" data-tip="previous transition"><ArrowLeftToLine size={14} /></span>
        <span class="btn icon" data-tip="next transition"><ArrowRightToLine size={14} /></span>
      </div>
      <span class="sp" style={{ flex: 1 }} />
      <span class="hint mono">
        {formatTimescale(SCENE.hierarchy.timescale)} ·{" "}
        <EditableNum value={s.viewRange.start} format={formatTime} onCommit={(n) => applyRange(n, s.viewRange.end)} />
        {" – "}
        <EditableNum value={s.viewRange.end} format={formatTime} onCommit={(n) => applyRange(s.viewRange.start, n)} /> ns
      </span>
      <div class="divider" />
      <div class="seg">
        <span class="btn icon" data-tip="zoom out" onClick={() => view.zoomBy(ZOOM_STEP)}><Minus size={14} /></span>
        <span class="btn icon" data-tip="zoom to fit" onClick={() => view.fitView()}><Maximize size={14} /></span>
        <span class="btn icon" data-tip="zoom in" onClick={() => view.zoomBy(1 / ZOOM_STEP)}><Plus size={14} /></span>
      </div>
      <div class="seg">
        <span
          class={`btn icon${s.snapCursor ? " on" : ""}`}
          data-tip={s.snapCursor ? "disable grid snap" : "enable grid snap"}
          onClick={() => s.toggleSnap()}
        ><Grid2x2 size={14} /></span>
        <span
          class={`btn icon${s.clockAnchor ? " on" : ""}`}
          data-tip={s.clockAnchor ? "align grid to timescale" : "align grid to clock"}
          onClick={() => s.toggleClock()}
        ><Clock size={14} /></span>
      </div>
    </div>
  );
}
