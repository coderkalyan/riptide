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

export const view = {
  startTicks: 0,
  ticksPerPixel: 0, // initialized to fit on first frame
  timelinePx: 0,    // canvas CSS width, stamped by the canvas each frame / on wheel
  seeded: false,    // one-shot seed of the persisted window
  userInteracted: false,
  zoomAnim: null as ZoomAnim | null,

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
    const tpp0 = this.ticksPerPixel > 0 ? this.ticksPerPixel : TRACE_END / this.timelinePx;
    this.userInteracted = true; // hold off auto-fit until the animation lands
    this.zoomAnim = { tpp0, start0: this.startTicks, tppT: TRACE_END / this.timelinePx, startT: 0, t0: performance.now(), releaseFit: true };
  },

  // Pan so the cursor sits at the left edge, keeping zoom (tppT == tpp0).
  jumpToCursor(cursorTick: number): void {
    const tpp = this.ticksPerPixel;
    if (tpp <= 0) return;
    this.userInteracted = true;
    this.zoomAnim = { tpp0: tpp, start0: this.startTicks, tppT: tpp, startT: cursorTick, t0: performance.now(), releaseFit: false };
  },

  // Commit an edited [start, end] window. Returns false on invalid input.
  applyRange(start: number, end: number): boolean {
    if (this.timelinePx <= 0 || !isFinite(start) || !isFinite(end) || start < 0 || end <= start) return false;
    this.zoomAnim = null;
    this.userInteracted = true;
    this.ticksPerPixel = (end - start) / this.timelinePx;
    this.startTicks = start;
    this.clampPan();
    return true;
  },

  // Re-seed + re-auto-fit on a trace swap (Phase 5).
  resetForTrace(): void {
    this.seeded = false;
    this.userInteracted = false;
    this.startTicks = 0;
    this.ticksPerPixel = 0;
    this.zoomAnim = null;
  },
};
