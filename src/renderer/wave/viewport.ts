// Viewport controller — the visible [startTicks, +width*ticksPerPixel] window
// plus button-zoom animation. Transient *render* state (not document state), so
// it's a module singleton: the rAF loop reads it every frame; pointer handlers
// and the toolbar mutate it. `timelinePx` (canvas CSS width) is stamped here each
// frame / on wheel, so toolbar actions (zoom/fit/range) need no canvas ref.
import { INITIAL, TRACE_END } from "../hier/scene";
import { ZOOM_ANIM_MS } from "./constants";

const easeOutCubic = (t: number) => 1 - Math.pow(1 - t, 3);

interface ZoomAnim {
  tpp0: number; start0: number; tppT: number; startT: number; t0: number; releaseFit: boolean;
}

// Ephemeral viewport-undo history (never persisted to the sidecar). Each entry is
// a committed window; an action records the pre-change window so undo can restore
// it. Wheel pan/zoom fires many events per gesture, so those are coalesced into
// one undo step.
interface ViewWindow { startTicks: number; ticksPerPixel: number; }
const HISTORY_LIMIT = 100;
const HISTORY_COALESCE_MS = 400;

export const view = {
  startTicks: 0,
  ticksPerPixel: 0, // initialized to fit on first frame
  timelinePx: 0,    // canvas CSS width, stamped by the canvas each frame / on wheel
  seeded: false,    // one-shot seed of the persisted window
  userInteracted: false,
  zoomAnim: null as ZoomAnim | null,
  history: [] as ViewWindow[],
  lastHistoryAt: 0,

  // Per-frame: seed once from the persisted window, else auto-fit until the user
  // interacts. A full-range saved window is left to auto-fit (keeps re-fitting on
  // resize); any other saved window is treated as an explicit zoom.
  ensureInit(): void {
    if (!this.seeded) {
      this.seeded = true;
      const span = INITIAL.time.end - INITIAL.time.start;
      const isFullRange =
        Math.abs(INITIAL.time.start) < 1e-6 && Math.abs(INITIAL.time.end - TRACE_END) < 1e-6;
      if (span > 0 && !isFullRange) {
        this.ticksPerPixel = span / this.timelinePx;
        this.startTicks = INITIAL.time.start;
        this.userInteracted = true;
      }
    }
    if (!this.userInteracted || this.ticksPerPixel <= 0) {
      this.ticksPerPixel = TRACE_END / this.timelinePx;
      this.startTicks = 0;
    }
  },

  // Advance a button-driven zoom animation. tpp eases geometrically; start eases
  // linearly. Returns true the frame it lands (caller persists the window).
  advance(now: number): boolean {
    const a = this.zoomAnim;
    if (!a) return false;
    const e = easeOutCubic(Math.min(1, (now - a.t0) / ZOOM_ANIM_MS));
    this.ticksPerPixel = a.tpp0 * Math.pow(a.tppT / a.tpp0, e);
    this.startTicks = a.start0 + (a.startT - a.start0) * e;
    if (e >= 1) {
      if (a.releaseFit) this.userInteracted = false;
      this.zoomAnim = null;
      return true;
    }
    return false;
  },

  clampPan(): void {
    const visibleTicks = this.timelinePx * this.ticksPerPixel;
    if (visibleTicks < TRACE_END) {
      this.startTicks = Math.max(0, Math.min(TRACE_END - visibleTicks, this.startTicks));
    } else {
      this.startTicks = 0;
    }
  },

  // Wheel/drag interaction is instant — drop any easing and freeze auto-fit.
  beginInteract(): void {
    this.pushHistory(HISTORY_COALESCE_MS);
    this.zoomAnim = null;
    this.userInteracted = true;
  },

  // ctrl+wheel: zoom anchored at the pointer.
  zoomAtPixel(mouseX: number, factor: number): void {
    const worldTickAtMouse = this.startTicks + mouseX * this.ticksPerPixel;
    this.ticksPerPixel *= factor;
    this.startTicks = worldTickAtMouse - mouseX * this.ticksPerPixel;
    this.clampPan();
  },

  // wheel pan (only meaningful when zoomed in past fit).
  panByPixels(dxPx: number): void {
    this.startTicks += dxPx * this.ticksPerPixel;
    this.clampPan();
  },

  // --- button-driven (toolbar) --------------------------------------------
  zoomBy(factor: number): void {
    this.pushHistory();
    this.userInteracted = true;
    const tpp0 = this.ticksPerPixel > 0 ? this.ticksPerPixel : TRACE_END / this.timelinePx;
    const start0 = this.startTicks;
    const centerX = this.timelinePx * 0.5;
    const worldTickAtCenter = start0 + centerX * tpp0;
    const tppT = tpp0 * factor;
    let startT = worldTickAtCenter - centerX * tppT;
    const visible = this.timelinePx * tppT;
    startT = visible < TRACE_END ? Math.max(0, Math.min(TRACE_END - visible, startT)) : 0;
    this.zoomAnim = { tpp0, start0, tppT, startT, t0: performance.now(), releaseFit: false };
  },

  fitView(): void {
    this.pushHistory();
    const tpp0 = this.ticksPerPixel > 0 ? this.ticksPerPixel : TRACE_END / this.timelinePx;
    this.userInteracted = true; // hold off auto-fit until the animation lands
    this.zoomAnim = { tpp0, start0: this.startTicks, tppT: TRACE_END / this.timelinePx, startT: 0, t0: performance.now(), releaseFit: true };
  },

  // Pan so the cursor sits at the left edge, keeping zoom (tppT == tpp0).
  jumpToCursor(cursorTick: number): void {
    const tpp = this.ticksPerPixel;
    if (tpp <= 0) return;
    this.pushHistory();
    this.userInteracted = true;
    this.zoomAnim = { tpp0: tpp, start0: this.startTicks, tppT: tpp, startT: cursorTick, t0: performance.now(), releaseFit: false };
  },

  // Commit an edited [start, end] window. Returns false on invalid input.
  applyRange(start: number, end: number): boolean {
    if (this.timelinePx <= 0 || !isFinite(start) || !isFinite(end) || start < 0 || end <= start) return false;
    this.pushHistory();
    this.zoomAnim = null;
    this.userInteracted = true;
    this.ticksPerPixel = (end - start) / this.timelinePx;
    this.startTicks = start;
    this.clampPan();
    return true;
  },

  // --- viewport undo history (ephemeral) ----------------------------------
  // Record the current window as an undo point. With coalesceMs > 0 (wheel
  // bursts) skip when the previous record landed within that interval; also
  // dedups a record identical to the last one.
  pushHistory(coalesceMs = 0): void {
    const now = performance.now();
    if (coalesceMs > 0 && now - this.lastHistoryAt < coalesceMs) return;
    this.lastHistoryAt = now;
    const top = this.history[this.history.length - 1];
    if (top && Math.abs(top.startTicks - this.startTicks) < 1e-6 && Math.abs(top.ticksPerPixel - this.ticksPerPixel) < 1e-9) return;
    this.history.push({ startTicks: this.startTicks, ticksPerPixel: this.ticksPerPixel });
    if (this.history.length > HISTORY_LIMIT) this.history.shift();
  },

  canUndo(): boolean {
    return this.history.length > 0;
  },

  // Animate back to the most recent recorded window. Skips records equal to the
  // current window (e.g. a wheel that hit a pan clamp and changed nothing). No-op
  // when the stack is empty.
  undo(): boolean {
    let prev: ViewWindow | undefined;
    while ((prev = this.history.pop())) {
      if (Math.abs(prev.startTicks - this.startTicks) > 1e-6 || Math.abs(prev.ticksPerPixel - this.ticksPerPixel) > 1e-9) break;
    }
    if (!prev) return false;
    this.userInteracted = true;
    const tpp0 = this.ticksPerPixel > 0 ? this.ticksPerPixel : prev.ticksPerPixel;
    this.zoomAnim = { tpp0, start0: this.startTicks, tppT: prev.ticksPerPixel, startT: prev.startTicks, t0: performance.now(), releaseFit: false };
    return true;
  },

  // Re-seed + re-auto-fit on a trace swap (Phase 5).
  resetForTrace(): void {
    this.seeded = false;
    this.userInteracted = false;
    this.startTicks = 0;
    this.ticksPerPixel = 0;
    this.zoomAnim = null;
    this.history = [];
    this.lastHistoryAt = 0;
  },
};
