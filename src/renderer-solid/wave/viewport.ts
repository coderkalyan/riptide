// Viewport controller — the visible [startTicks, +width*ticksPerPixel] window
// plus button-zoom animation. This is transient *render* state (not document
// state), so it lives here as a module singleton rather than in the store: the
// rAF loop reads it every frame, pointer handlers + (Phase 4) the toolbar mutate
// it. Ported from App.tsx's viewport refs + zoom/fit/pan handlers.
import { INITIAL } from "../../renderer/hier/scene";
import { MOCK_END_TICKS } from "../../renderer/gpu/data";
import { ZOOM_ANIM_MS } from "./constants";

const easeOutCubic = (t: number) => 1 - Math.pow(1 - t, 3);

interface ZoomAnim {
  tpp0: number; start0: number; tppT: number; startT: number; t0: number; releaseFit: boolean;
}

export const view = {
  startTicks: 0,
  ticksPerPixel: 0, // initialized to fit on first frame
  seeded: false,    // one-shot seed of the persisted window
  userInteracted: false,
  zoomAnim: null as ZoomAnim | null,
  _save: false,     // set when an animation lands → frame triggers a sidecar save

  // Per-frame: seed once from the persisted window, else auto-fit until the user
  // interacts. A full-range saved window is left to auto-fit (keeps re-fitting on
  // resize); any other saved window is treated as an explicit zoom.
  ensureInit(timelinePx: number): void {
    if (!this.seeded) {
      this.seeded = true;
      const span = INITIAL.time.end - INITIAL.time.start;
      const isFullRange =
        Math.abs(INITIAL.time.start) < 1e-6 && Math.abs(INITIAL.time.end - MOCK_END_TICKS) < 1e-6;
      if (span > 0 && !isFullRange) {
        this.ticksPerPixel = span / timelinePx;
        this.startTicks = INITIAL.time.start;
        this.userInteracted = true;
      }
    }
    if (!this.userInteracted || this.ticksPerPixel <= 0) {
      this.ticksPerPixel = MOCK_END_TICKS / timelinePx;
      this.startTicks = 0;
    }
  },

  // Advance a button-driven zoom animation. tpp eases geometrically (constant-
  // ratio zoom feels uniform); start eases linearly. Returns true the frame it
  // lands (so the caller persists the final window).
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

  clampPan(timelinePx: number): void {
    const visibleTicks = timelinePx * this.ticksPerPixel;
    if (visibleTicks < MOCK_END_TICKS) {
      this.startTicks = Math.max(0, Math.min(MOCK_END_TICKS - visibleTicks, this.startTicks));
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
  zoomAtPixel(mouseX: number, factor: number, timelinePx: number): void {
    const worldTickAtMouse = this.startTicks + mouseX * this.ticksPerPixel;
    this.ticksPerPixel *= factor;
    this.startTicks = worldTickAtMouse - mouseX * this.ticksPerPixel;
    this.clampPan(timelinePx);
  },

  // wheel pan (only meaningful when zoomed in past fit).
  panByPixels(dxPx: number, timelinePx: number): void {
    this.startTicks += dxPx * this.ticksPerPixel;
    this.clampPan(timelinePx);
  },

  // --- button-driven (toolbar, Phase 4) -----------------------------------
  zoomBy(factor: number, timelinePx: number, now: number): void {
    this.userInteracted = true;
    const tpp0 = this.ticksPerPixel > 0 ? this.ticksPerPixel : MOCK_END_TICKS / timelinePx;
    const start0 = this.startTicks;
    const centerX = timelinePx * 0.5;
    const worldTickAtCenter = start0 + centerX * tpp0;
    const tppT = tpp0 * factor;
    let startT = worldTickAtCenter - centerX * tppT;
    const visible = timelinePx * tppT;
    startT = visible < MOCK_END_TICKS ? Math.max(0, Math.min(MOCK_END_TICKS - visible, startT)) : 0;
    this.zoomAnim = { tpp0, start0, tppT, startT, t0: now, releaseFit: false };
  },

  fitView(timelinePx: number, now: number): void {
    const tpp0 = this.ticksPerPixel > 0 ? this.ticksPerPixel : MOCK_END_TICKS / timelinePx;
    this.userInteracted = true; // hold off auto-fit until the animation lands
    this.zoomAnim = { tpp0, start0: this.startTicks, tppT: MOCK_END_TICKS / timelinePx, startT: 0, t0: now, releaseFit: true };
  },

  // Pan so the cursor sits at the left edge, keeping zoom (tppT == tpp0).
  jumpToCursor(cursorTick: number, now: number): void {
    const tpp = this.ticksPerPixel;
    if (tpp <= 0) return;
    this.userInteracted = true;
    this.zoomAnim = { tpp0: tpp, start0: this.startTicks, tppT: tpp, startT: cursorTick, t0: now, releaseFit: false };
  },

  // Commit an edited [start, end] window. Returns false on invalid input.
  applyRange(start: number, end: number, timelinePx: number): boolean {
    if (timelinePx <= 0 || !isFinite(start) || !isFinite(end) || start < 0 || end <= start) return false;
    this.zoomAnim = null;
    this.userInteracted = true;
    this.ticksPerPixel = (end - start) / timelinePx;
    this.startTicks = start;
    this.clampPan(timelinePx);
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
