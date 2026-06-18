import {
  ArrowLeftToLine, ArrowRightToLine, ChevronFirst, ChevronLast, ChevronLeft, ChevronRight,
  Clock, Grid2x2, Maximize, Minus, Plus, Save, Undo2,
} from "lucide-solid";
import { SCENE, TRACE_END, handleForPath } from "./hier/scene";
import { useAppStore } from "./store/store";
import { getEdges } from "./native";
import { view } from "./wave/viewport";
import { formatTime, formatTimescale, timeUnit } from "./wave/format";
import { ZOOM_STEP } from "./wave/constants";
import { EditableNum } from "./EditableNum";
import { ClockPicker } from "./ClockPicker";
import { requestCanvasCapture } from "./wave/capture";

declare const require: (m: string) => unknown;

// Snapshot the waveform canvas (next rendered frame) and hand the PNG bytes to
// the main process, which shows a native save dialog.
async function saveCanvas() {
  const blob = await requestCanvasCapture();
  if (!blob) return;
  const bytes = new Uint8Array(await blob.arrayBuffer());
  try {
    const ipc = (require("electron") as { ipcRenderer: { invoke(c: string, ...a: unknown[]): Promise<unknown> } }).ipcRenderer;
    await ipc.invoke("riptide:save-canvas", bytes);
  } catch (e) {
    console.error("[save-canvas] failed", e);
  }
}

// Waves toolbar: cursor pill (jump-to-cursor + edit), quad nav (jump-to-start,
// step back/forward by a clock cycle, jump-to-end — each moves the cursor and
// the viewport follows via view.revealTick), editable [start–end] range, zoom
// in/out/fit, snap + clock toggles. Transition nav (prev/next value change of
// the lone selected signal; disabled unless exactly one row is selected) also
// moves the cursor + follows. Zoom/nav drive the viewport controller; toggles
// drive the store.
export function WavesToolbar() {
  const s = useAppStore();
  // Time unit + timescale label from the loaded trace, re-read on every trace
  // swap (traceNonce) so an in-app Open VCD… updates them (was hardcoded "ns").
  const unit = () => { s.traceNonce; return timeUnit(); };
  const tsLabel = () => { s.traceNonce; return formatTimescale(SCENE.hierarchy.timescale); };
  // Clock-align is only meaningful when there's a clock to anchor to: a
  // role:"clock" row, an already-chosen timebase, or it's already on (so it can
  // be turned off). Without one, toggleClock silently no-ops — disable instead.
  const clockAvailable = () => s.clockAnchor || s.timebaseClock != null || s.activeSignals.some((r) => r.role === "clock");
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
  // Move the cursor to `tick` (clamped to the trace) and let the viewport follow.
  const jumpTo = (tick: number) => {
    const t = Math.max(0, Math.min(TRACE_END, tick));
    s.setCursor(t);
    view.revealTick(t);
  };
  // Step the cursor one clock cycle back/forward (next/prev reference edge of the
  // timebase grid). With no valid grid, nudge by ~10% of the visible window.
  const stepCursor = (dir: 1 | -1) => {
    const cur = s.cursorTicks;
    const g = s.clockGrid;
    let next: number;
    if (g && g.valid && g.period > 0) {
      const rel = (cur - g.phase) / g.period;
      const k = dir > 0 ? Math.floor(rel + 1e-6) + 1 : Math.ceil(rel - 1e-6) - 1;
      next = g.phase + k * g.period;
    } else {
      const visible = view.ticksPerPixel * view.timelinePx;
      next = cur + dir * Math.max(1, Math.round(visible * 0.1));
    }
    jumpTo(next);
  };
  // Transition nav targets the lone selected signal — disabled unless exactly one
  // row is selected (no ambiguity about which signal's edges to walk).
  const oneSelected = () => s.activeSignals.filter((r) => r.selected).length === 1;
  // Move the cursor to the prev/next value change of that signal. queryNext (via
  // getEdges) returns the sample at/before `start` as element[0], so: next = the
  // first returned tick strictly after the cursor; prev = element[0] when it sits
  // before the cursor, else the boundary one tick before it.
  const gotoTransition = (dir: 1 | -1) => {
    const sel = s.activeSignals.find((r) => r.selected);
    const handle = sel && oneSelected() ? handleForPath(sel.path) : null;
    if (!handle) return;
    const cur = s.cursorTicks;
    const eps = 1e-6;
    let next: number | null = null;
    if (dir > 0) {
      const q = getEdges(handle, cur, 2);
      if (q) for (let i = 0; i < q.count; i++) if (q.ticks[i] > cur + eps) { next = q.ticks[i]; break; }
    } else {
      const q = getEdges(handle, cur, 1);
      if (q && q.count > 0) {
        const s0 = q.ticks[0];
        if (s0 < cur - eps) next = s0; // cursor inside a segment → its start boundary
        else if (s0 > 0) {              // cursor on a boundary → the one before it
          const q2 = getEdges(handle, s0 - 1, 1);
          if (q2 && q2.count > 0 && q2.ticks[0] < s0 - eps) next = q2.ticks[0];
        }
      }
    }
    if (next != null) jumpTo(next);
  };

  return (
    <div class="col-head toolbar">
      <span class="pill" data-tip="jump to cursor" onClick={() => view.jumpToCursor(s.cursorTicks)}>
        <span class="swatch" />
        <span class="mono">cursor at{" "}
          <span data-tip="edit cursor time" onClick={(e) => e.stopPropagation()}>
            <EditableNum value={s.cursorTicks} format={formatTime} onCommit={applyCursor} />
          </span>{" "}{unit()}
        </span>
      </span>
      <div class="seg">
        <span class="btn icon" data-tip="jump to start" onClick={() => jumpTo(0)}><ChevronFirst size={14} /></span>
        <span class="btn icon" data-tip="step back" onClick={() => stepCursor(-1)}><ChevronLeft size={14} /></span>
        <span class="btn icon" data-tip="step forward" onClick={() => stepCursor(1)}><ChevronRight size={14} /></span>
        <span class="btn icon" data-tip="jump to end" onClick={() => jumpTo(TRACE_END)}><ChevronLast size={14} /></span>
      </div>
      <div class="seg">
        <span
          class={`btn icon${oneSelected() ? "" : " disabled"}`}
          data-tip={oneSelected() ? "previous transition" : "select one signal to step transitions"}
          onClick={() => gotoTransition(-1)}
        ><ArrowLeftToLine size={14} /></span>
        <span
          class={`btn icon${oneSelected() ? "" : " disabled"}`}
          data-tip={oneSelected() ? "next transition" : "select one signal to step transitions"}
          onClick={() => gotoTransition(1)}
        ><ArrowRightToLine size={14} /></span>
      </div>
      <span class="sp" />
      <div class="ts-box">
        <span class="ts-range mono">
          <EditableNum value={s.viewRange.start} format={formatTime} onCommit={(n) => applyRange(n, s.viewRange.end)} />
          {" – "}
          <EditableNum value={s.viewRange.end} format={formatTime} onCommit={(n) => applyRange(s.viewRange.start, n)} /> {unit()}
        </span>
        <span class="ts-info mono">{tsLabel()}</span>
      </div>
      <div class="divider" />
      <span class="btn icon" data-tip="undo view change" onClick={() => view.undo()}><Undo2 size={14} /></span>
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
          class={`btn icon${s.clockAnchor ? " on" : ""}${clockAvailable() ? "" : " disabled"}`}
          data-tip={!clockAvailable() ? "no clock-format signal to align to" : s.clockAnchor ? "align grid to timescale" : "align grid to clock"}
          onClick={() => { if (clockAvailable()) s.toggleClock(); }}
        ><Clock size={14} /></span>
      </div>
      <ClockPicker />
      <div class="divider" />
      <span class="btn icon" data-tip="save canvas image" onClick={saveCanvas}><Save size={14} /></span>
    </div>
  );
}
