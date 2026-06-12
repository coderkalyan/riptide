//! The viewport controller: pan/zoom/fit, eased zoom animation, view history,
//! and the repack-window policy. Port of `src/renderer/wave/viewport.ts` plus
//! the over-fetch/guard-band window logic from `WaveCanvas.tsx`.
//!
//! OWNED BY UNIT U4 (with `input.rs`). Time is injected (`now_ms`) — no
//! wall-clock reads — for deterministic tests and wasm cleanliness. All math
//! is f64 to match JS `number` semantics exactly; coordinates are CSS px (see
//! the DPR contract in CLAUDE.md).

// --- constants (mirrors src/renderer/wave/constants.ts) ---------------------

/// Button-zoom animation duration.
pub const ZOOM_ANIM_MS: f64 = 120.0;
/// `Math.exp()` factor per wheel deltaY unit.
pub const ZOOM_PER_DELTA_Y: f64 = 0.001;
/// Toolbar/keyboard zoom step (zoom out ×step, zoom in ×1/step).
pub const ZOOM_STEP: f64 = 1.25;
/// Repack once the view is this much more zoomed out than the packed density.
pub const ZOOM_OUT_FACTOR: f64 = 1.5;
/// Re-window when the packed span exceeds this × the visible span.
pub const WINDOW_SHRINK_FACTOR: f64 = 6.0;
/// Vertical-line thickness — MUST match the `thickness` literal in lines.wgsl.
pub const LINE_THICKNESS_CSS: f64 = 2.5;
/// Half-thickness: the hover-centering bias (see the vertical-line alignment
/// contract in CLAUDE.md — `tickAtClientX` subtracts this so clicks land where
/// the centered hover guide sat).
pub const LINE_HALF_CSS: f64 = LINE_THICKNESS_CSS * 0.5;

const HISTORY_LIMIT: usize = 100;
const HISTORY_COALESCE_MS: f64 = 400.0;

fn ease_out_cubic(t: f64) -> f64 {
    1.0 - (1.0 - t).powi(3)
}

/// Button-driven zoom animation: tpp eases geometrically, start linearly.
#[derive(Clone, Copy, Debug)]
struct ZoomAnim {
    tpp0: f64,
    start0: f64,
    tpp_t: f64,
    start_t: f64,
    t0: f64,
    /// Hand the window back to auto-fit once the animation lands (fit button).
    release_fit: bool,
}

/// One committed window in the ephemeral undo history (never persisted).
#[derive(Clone, Copy, Debug, PartialEq)]
struct ViewWindow {
    start_ticks: f64,
    ticks_per_pixel: f64,
}

/// The tick window the GPU buffers currently hold, plus the ticks/pixel it was
/// packed at (the zoom-out clause compares densities). Mirrors WaveCanvas's
/// `packedRange`.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct PackedWindow {
    pub start: u64,
    pub end: u64,
    pub tpp: f64,
}

/// Result of one per-frame [`Viewport::tick`].
#[derive(Clone, Copy, Debug, Default)]
pub struct ViewportTick {
    /// The view changed this tick (or an animation is in flight) — redraw.
    pub dirty: bool,
    /// A zoom/fit/undo animation finished this tick → emit a settled
    /// `ViewportChanged` (JS persists the window). Fires exactly once.
    pub settled: bool,
}

/// The visible `[start_ticks, start_ticks + timeline_px * ticks_per_pixel]`
/// window plus button-zoom animation. Faithful port of viewport.ts's `view`
/// singleton; the trace end (`TRACE_END`) and the persisted initial window are
/// injected via [`Viewport::reset_for_trace`] instead of read from globals.
#[derive(Debug, Default)]
pub struct Viewport {
    start_ticks: f64,
    ticks_per_pixel: f64, // 0 until seeded → fit on first tick
    timeline_px: f64,     // canvas CSS width, stamped via set_width
    seeded: bool,         // one-shot seed of the persisted window
    user_interacted: bool,
    zoom_anim: Option<ZoomAnim>,
    history: Vec<ViewWindow>,
    last_history_at: f64,
    /// The trace's last event time (TRACE_END).
    end_ticks: f64,
    /// Persisted `[start, end]` window from the sidecar, seeded once.
    initial: Option<(f64, f64)>,
}

impl Viewport {
    pub fn new() -> Self {
        Self::default()
    }

    // --- accessors -----------------------------------------------------------

    pub fn start_ticks(&self) -> f64 {
        self.start_ticks
    }

    pub fn ticks_per_pixel(&self) -> f64 {
        self.ticks_per_pixel
    }

    /// Canvas CSS width.
    pub fn timeline_px(&self) -> f64 {
        self.timeline_px
    }

    /// The trace's last event time (set by `reset_for_trace`).
    pub fn end_ticks(&self) -> f64 {
        self.end_ticks
    }

    /// The view holds an explicit user zoom (auto-fit frozen).
    pub fn user_interacted(&self) -> bool {
        self.user_interacted
    }

    /// A button-zoom animation is in flight (keeps the frame loop drawing).
    pub fn animating(&self) -> bool {
        self.zoom_anim.is_some()
    }

    /// The visible window end, `start + width × tpp`.
    pub fn view_end(&self) -> f64 {
        self.start_ticks + self.timeline_px * self.ticks_per_pixel
    }

    /// `xForTick`: logical time → CSS-px x (the line's LEFT edge; see the
    /// vertical-line alignment contract in CLAUDE.md).
    pub fn x_for_tick(&self, t: f64) -> f64 {
        (t - self.start_ticks) / self.ticks_per_pixel
    }

    // --- lifecycle -----------------------------------------------------------

    /// Re-seed + re-auto-fit on a trace swap (port of `resetForTrace`), also
    /// carrying the new trace end and the sidecar's persisted `[start, end]`
    /// window (None = no sidecar → plain auto-fit).
    pub fn reset_for_trace(&mut self, end_ticks: u64, initial: Option<(f64, f64)>) {
        self.seeded = false;
        self.user_interacted = false;
        self.start_ticks = 0.0;
        self.ticks_per_pixel = 0.0;
        self.zoom_anim = None;
        self.history.clear();
        self.last_history_at = 0.0;
        self.end_ticks = end_ticks as f64;
        self.initial = initial;
    }

    /// Stamp the canvas CSS width. When the width actually changes while the
    /// user holds an explicit zoom, preserve the logical `[start, end]` window
    /// by rescaling ticks/pixel (physical scale changes, logical zoom does
    /// not). The auto-fit path re-fits full-range each tick, and an in-flight
    /// zoom animation owns ticks/pixel, so both are left untouched.
    pub fn set_width(&mut self, px: f64) {
        let old = self.timeline_px;
        if px > 0.0
            && old > 0.0
            && (px - old).abs() > 0.5
            && self.user_interacted
            && self.zoom_anim.is_none()
            && self.ticks_per_pixel > 0.0
        {
            self.ticks_per_pixel = (old * self.ticks_per_pixel) / px;
            self.timeline_px = px;
            self.clamp_pan();
            return;
        }
        self.timeline_px = px;
    }

    /// Per-tick: seed once from the persisted window, else auto-fit until the
    /// user interacts. A full-range saved window is left to auto-fit (keeps
    /// re-fitting on resize); any other saved window is an explicit zoom.
    fn ensure_init(&mut self) {
        if self.timeline_px <= 0.0 {
            return; // nothing to fit into yet (the TS frame loop gates on this)
        }
        if !self.seeded {
            self.seeded = true;
            if let Some((start, end)) = self.initial {
                let span = end - start;
                let is_full_range = start.abs() < 1e-6 && (end - self.end_ticks).abs() < 1e-6;
                if span > 0.0 && !is_full_range {
                    self.ticks_per_pixel = span / self.timeline_px;
                    self.start_ticks = start;
                    self.user_interacted = true;
                }
            }
        }
        if !self.user_interacted || self.ticks_per_pixel <= 0.0 {
            self.ticks_per_pixel = self.end_ticks / self.timeline_px;
            self.start_ticks = 0.0;
        }
    }

    /// Advance a button-driven zoom animation. tpp eases geometrically; start
    /// eases linearly. Returns true the tick it lands.
    fn advance(&mut self, now_ms: f64) -> bool {
        let Some(a) = self.zoom_anim else { return false };
        let e = ease_out_cubic(((now_ms - a.t0) / ZOOM_ANIM_MS).min(1.0));
        self.ticks_per_pixel = a.tpp0 * (a.tpp_t / a.tpp0).powf(e);
        self.start_ticks = a.start0 + (a.start_t - a.start0) * e;
        if e >= 1.0 {
            if a.release_fit {
                self.user_interacted = false;
            }
            self.zoom_anim = None;
            return true;
        }
        false
    }

    /// One per-frame step: seed/auto-fit + advance the zoom animation
    /// (`ensureInit` + `advance` in the TS rAF loop).
    pub fn tick(&mut self, now_ms: f64) -> ViewportTick {
        let (s0, t0) = (self.start_ticks, self.ticks_per_pixel);
        self.ensure_init();
        let settled = self.advance(now_ms);
        let dirty = settled
            || self.zoom_anim.is_some()
            || self.start_ticks != s0
            || self.ticks_per_pixel != t0;
        ViewportTick { dirty, settled }
    }

    // --- interaction ---------------------------------------------------------

    fn clamp_pan(&mut self) {
        let visible_ticks = self.timeline_px * self.ticks_per_pixel;
        if visible_ticks < self.end_ticks {
            self.start_ticks = self.start_ticks.clamp(0.0, self.end_ticks - visible_ticks);
        } else {
            self.start_ticks = 0.0;
        }
    }

    /// Wheel/drag interaction is instant — drop any easing and freeze auto-fit.
    pub fn begin_interact(&mut self, now_ms: f64) {
        self.push_history(HISTORY_COALESCE_MS, now_ms);
        self.zoom_anim = None;
        self.user_interacted = true;
    }

    /// ctrl+wheel: zoom anchored at the pointer.
    pub fn zoom_at_pixel(&mut self, mouse_x: f64, factor: f64) {
        let world_tick_at_mouse = self.start_ticks + mouse_x * self.ticks_per_pixel;
        self.ticks_per_pixel *= factor;
        self.start_ticks = world_tick_at_mouse - mouse_x * self.ticks_per_pixel;
        self.clamp_pan();
    }

    /// Wheel pan (only meaningful when zoomed in past fit).
    pub fn pan_by_pixels(&mut self, dx_px: f64) {
        self.start_ticks += dx_px * self.ticks_per_pixel;
        self.clamp_pan();
    }

    // --- button-driven (toolbar / keyboard) ----------------------------------

    /// Animated zoom about the view center (toolbar ±, Ctrl+=/Ctrl+-).
    /// `factor > 1` zooms out, `< 1` zooms in (callers pass `ZOOM_STEP` /
    /// `1/ZOOM_STEP`).
    pub fn zoom_by(&mut self, factor: f64, now_ms: f64) {
        self.push_history(0.0, now_ms);
        self.user_interacted = true;
        let tpp0 = if self.ticks_per_pixel > 0.0 {
            self.ticks_per_pixel
        } else {
            self.end_ticks / self.timeline_px
        };
        let start0 = self.start_ticks;
        let center_x = self.timeline_px * 0.5;
        let world_tick_at_center = start0 + center_x * tpp0;
        let tpp_t = tpp0 * factor;
        let mut start_t = world_tick_at_center - center_x * tpp_t;
        let visible = self.timeline_px * tpp_t;
        start_t = if visible < self.end_ticks {
            start_t.clamp(0.0, self.end_ticks - visible)
        } else {
            0.0
        };
        self.zoom_anim =
            Some(ZoomAnim { tpp0, start0, tpp_t, start_t, t0: now_ms, release_fit: false });
    }

    /// Animated fit to `[0, end_ticks]`; hands the window back to auto-fit
    /// once the animation lands.
    pub fn fit_view(&mut self, now_ms: f64) {
        self.push_history(0.0, now_ms);
        let tpp0 = if self.ticks_per_pixel > 0.0 {
            self.ticks_per_pixel
        } else {
            self.end_ticks / self.timeline_px
        };
        self.user_interacted = true; // hold off auto-fit until the animation lands
        self.zoom_anim = Some(ZoomAnim {
            tpp0,
            start0: self.start_ticks,
            tpp_t: self.end_ticks / self.timeline_px,
            start_t: 0.0,
            t0: now_ms,
            release_fit: true,
        });
    }

    /// Pan so the cursor sits at the left edge, keeping zoom (tppT == tpp0).
    pub fn jump_to_cursor(&mut self, cursor_tick: f64, now_ms: f64) {
        let tpp = self.ticks_per_pixel;
        if tpp <= 0.0 {
            return;
        }
        self.push_history(0.0, now_ms);
        self.user_interacted = true;
        self.zoom_anim = Some(ZoomAnim {
            tpp0: tpp,
            start0: self.start_ticks,
            tpp_t: tpp,
            start_t: cursor_tick,
            t0: now_ms,
            release_fit: false,
        });
    }

    /// Commit an edited `[start, end]` window (toolbar range fields / doc
    /// sync). Returns false on invalid input.
    pub fn apply_range(&mut self, start: f64, end: f64, now_ms: f64) -> bool {
        if self.timeline_px <= 0.0
            || !start.is_finite()
            || !end.is_finite()
            || start < 0.0
            || end <= start
        {
            return false;
        }
        self.push_history(0.0, now_ms);
        self.zoom_anim = None;
        self.user_interacted = true;
        self.ticks_per_pixel = (end - start) / self.timeline_px;
        self.start_ticks = start;
        self.clamp_pan();
        true
    }

    // --- viewport undo history (ephemeral) ------------------------------------

    /// Record the current window as an undo point. With `coalesce_ms > 0`
    /// (wheel bursts) skip when the previous record landed within that
    /// interval; also dedups a record identical to the last one.
    fn push_history(&mut self, coalesce_ms: f64, now_ms: f64) {
        if coalesce_ms > 0.0 && now_ms - self.last_history_at < coalesce_ms {
            return;
        }
        self.last_history_at = now_ms;
        if let Some(top) = self.history.last()
            && (top.start_ticks - self.start_ticks).abs() < 1e-6
            && (top.ticks_per_pixel - self.ticks_per_pixel).abs() < 1e-9
        {
            return;
        }
        self.history.push(ViewWindow {
            start_ticks: self.start_ticks,
            ticks_per_pixel: self.ticks_per_pixel,
        });
        if self.history.len() > HISTORY_LIMIT {
            self.history.remove(0);
        }
    }

    pub fn can_undo(&self) -> bool {
        !self.history.is_empty()
    }

    /// Animate back to the most recent recorded window. Skips records equal to
    /// the current window (e.g. a wheel that hit a pan clamp and changed
    /// nothing). No-op when the stack is empty.
    pub fn undo(&mut self, now_ms: f64) -> bool {
        let mut prev = None;
        while let Some(p) = self.history.pop() {
            if (p.start_ticks - self.start_ticks).abs() > 1e-6
                || (p.ticks_per_pixel - self.ticks_per_pixel).abs() > 1e-9
            {
                prev = Some(p);
                break;
            }
        }
        let Some(prev) = prev else { return false };
        self.user_interacted = true;
        let tpp0 = if self.ticks_per_pixel > 0.0 {
            self.ticks_per_pixel
        } else {
            prev.ticks_per_pixel
        };
        self.zoom_anim = Some(ZoomAnim {
            tpp0,
            start0: self.start_ticks,
            tpp_t: prev.ticks_per_pixel,
            start_t: prev.start_ticks,
            t0: now_ms,
            release_fit: false,
        });
        true
    }

    // --- repack-window policy -------------------------------------------------

    /// The viewport-windowed repack policy from the WaveCanvas frame loop.
    /// Pack over the visible window plus a one-screen over-fetch margin, but
    /// only when the visible range entered the hysteresis guard band at either
    /// packed edge, the user zoomed out past `ZOOM_OUT_FACTOR`× the packed
    /// density, or the packed window is `WINDOW_SHRINK_FACTOR`× wider than the
    /// visible span. Pan and zoom-in within the margin return None — pure
    /// uniform updates.
    ///
    /// Returns the clamped `[q_start, q_end]` to pack. Caller semantics
    /// (mirror WaveCanvas): on Some, refresh its `PackedWindow` to the
    /// returned window at the *current* tpp even when it skips the GPU rebuild
    /// because the clamped window is unchanged (e.g. zooming further out while
    /// already covering the whole trace) — otherwise the zoom-out clause fires
    /// every frame. An active-set change (`specsDirty`) must repack regardless;
    /// use [`Viewport::query_window`] for that path.
    pub fn needed_window(
        &self,
        packed: Option<PackedWindow>,
        end_ticks: u64,
    ) -> Option<(u64, u64)> {
        if self.timeline_px <= 0.0 || self.ticks_per_pixel <= 0.0 {
            return None;
        }
        let visible_ticks = self.timeline_px * self.ticks_per_pixel;
        let view_end = self.start_ticks + visible_ticks;
        let m = visible_ticks; // over-fetch one screen of ticks each side
        let g = m * 0.5; // guard band: repack at halfway into the margin
        // Edge clauses are gated on there being room beyond the trace bounds —
        // at the trace start/end the packed window is clamped to 0/end, so the
        // visible edge sitting on it must NOT keep retriggering.
        let need_repack = match packed {
            None => true,
            Some(pr) => {
                (pr.start > 0 && self.start_ticks < pr.start as f64 + g)
                    || (pr.end < end_ticks && view_end > pr.end as f64 - g)
                    || self.ticks_per_pixel > pr.tpp * ZOOM_OUT_FACTOR
                    || (pr.end - pr.start) as f64 > visible_ticks * WINDOW_SHRINK_FACTOR
            }
        };
        if !need_repack {
            return None;
        }
        Some(self.query_window(end_ticks))
    }

    /// The over-fetched, trace-clamped pack window for the current view —
    /// the `[q_start, q_end]` a repack queries (also used directly for
    /// specs-dirty repacks, which bypass the hysteresis clauses).
    pub fn query_window(&self, end_ticks: u64) -> (u64, u64) {
        let visible_ticks = self.timeline_px * self.ticks_per_pixel;
        let m = visible_ticks;
        let q_start = (self.start_ticks - m).floor().max(0.0) as u64;
        let q_end = ((self.start_ticks + visible_ticks + m).ceil() as u64).min(end_ticks);
        (q_start, q_end)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const EPS: f64 = 1e-9;

    fn assert_close(a: f64, b: f64) {
        assert!((a - b).abs() < EPS, "{a} != {b}");
    }

    /// A viewport seeded at auto-fit: end=1000 ticks over a 100 px canvas.
    fn fit_vp() -> Viewport {
        let mut v = Viewport::new();
        v.reset_for_trace(1000, None);
        v.set_width(100.0);
        v.tick(0.0);
        v
    }

    #[test]
    fn seeds_auto_fit_covering_full_trace() {
        let v = fit_vp();
        assert_close(v.start_ticks(), 0.0);
        assert_close(v.ticks_per_pixel(), 10.0);
        assert_close(v.view_end(), 1000.0);
        assert!(!v.user_interacted());
    }

    #[test]
    fn seeds_persisted_window_as_explicit_zoom() {
        let mut v = Viewport::new();
        v.reset_for_trace(1000, Some((100.0, 300.0)));
        v.set_width(100.0);
        let t = v.tick(0.0);
        assert!(t.dirty);
        assert_close(v.start_ticks(), 100.0);
        assert_close(v.ticks_per_pixel(), 2.0);
        assert!(v.user_interacted());
    }

    #[test]
    fn full_range_persisted_window_stays_auto_fit() {
        let mut v = Viewport::new();
        v.reset_for_trace(1000, Some((0.0, 1000.0)));
        v.set_width(100.0);
        v.tick(0.0);
        assert!(!v.user_interacted());
        assert_close(v.ticks_per_pixel(), 10.0);
        // Auto-fit keeps re-fitting on resize.
        v.set_width(200.0);
        v.tick(16.0);
        assert_close(v.ticks_per_pixel(), 5.0);
        assert_close(v.start_ticks(), 0.0);
    }

    #[test]
    fn zoom_at_pixel_keeps_anchor_tick_under_pointer() {
        let mut v = fit_vp();
        v.begin_interact(1000.0);
        let anchor = v.start_ticks() + 30.0 * v.ticks_per_pixel(); // tick 300
        v.zoom_at_pixel(30.0, 0.5);
        assert_close(v.ticks_per_pixel(), 5.0);
        assert_close(v.start_ticks() + 30.0 * v.ticks_per_pixel(), anchor);
    }

    #[test]
    fn zoom_out_past_fit_clamps_to_origin() {
        let mut v = fit_vp();
        v.begin_interact(1000.0);
        v.zoom_at_pixel(50.0, 10.0); // visible = 10000 ≥ end → start pinned to 0
        assert_close(v.start_ticks(), 0.0);
    }

    #[test]
    fn pan_clamps_to_trace_bounds() {
        let mut v = fit_vp();
        assert!(v.apply_range(200.0, 400.0, 0.0)); // tpp 2, visible 200
        v.pan_by_pixels(1e6);
        assert_close(v.start_ticks(), 800.0); // end - visible
        v.pan_by_pixels(-1e9);
        assert_close(v.start_ticks(), 0.0);
    }

    #[test]
    fn set_width_preserves_logical_window_under_explicit_zoom() {
        let mut v = fit_vp();
        assert!(v.apply_range(200.0, 400.0, 0.0));
        v.set_width(50.0);
        assert_close(v.start_ticks(), 200.0);
        assert_close(v.ticks_per_pixel(), 4.0); // same [200,400] over 50 px
        assert_close(v.view_end(), 400.0);
    }

    #[test]
    fn fit_animation_covers_full_range_and_settles_exactly_once() {
        let mut v = fit_vp();
        assert!(v.apply_range(200.0, 400.0, 0.0));
        v.fit_view(1000.0);
        assert!(v.user_interacted()); // auto-fit held off during the animation

        let mid = v.tick(1060.0);
        assert!(mid.dirty && !mid.settled);
        // Mid-flight values follow the eased curve exactly.
        let e = 1.0 - (1.0 - 0.5_f64).powi(3);
        assert_close(v.ticks_per_pixel(), 2.0 * (10.0_f64 / 2.0).powf(e));
        assert_close(v.start_ticks(), 200.0 + (0.0 - 200.0) * e);

        let land = v.tick(1120.0);
        assert!(land.dirty && land.settled);
        assert_close(v.start_ticks(), 0.0);
        assert_close(v.ticks_per_pixel(), 10.0);
        assert!(!v.user_interacted()); // fit releases back to auto-fit

        let after = v.tick(1140.0);
        assert!(!after.dirty && !after.settled); // settled fires exactly once
    }

    #[test]
    fn zoom_by_clamps_animation_target() {
        let mut v = fit_vp();
        v.zoom_by(ZOOM_STEP, 0.0); // zoom out from fit → target visible > end
        v.tick(ZOOM_ANIM_MS);
        assert_close(v.start_ticks(), 0.0);
        assert_close(v.ticks_per_pixel(), 12.5);
    }

    #[test]
    fn jump_to_cursor_pans_keeping_zoom() {
        let mut v = fit_vp();
        assert!(v.apply_range(0.0, 200.0, 0.0)); // tpp 2
        v.jump_to_cursor(500.0, 100.0);
        let t = v.tick(100.0 + ZOOM_ANIM_MS);
        assert!(t.settled);
        assert_close(v.start_ticks(), 500.0);
        assert_close(v.ticks_per_pixel(), 2.0);
    }

    #[test]
    fn apply_range_rejects_invalid_input() {
        let mut v = fit_vp();
        assert!(!v.apply_range(-1.0, 100.0, 0.0));
        assert!(!v.apply_range(100.0, 100.0, 0.0));
        assert!(!v.apply_range(200.0, 100.0, 0.0));
        assert!(!v.apply_range(0.0, f64::NAN, 0.0));
        assert!(!v.apply_range(f64::INFINITY, 100.0, 0.0));
    }

    #[test]
    fn wheel_burst_coalesces_into_one_undo_step() {
        let mut v = fit_vp();
        // Gesture 1: three wheel events inside the 400 ms coalesce window →
        // one history entry (the fit window).
        v.begin_interact(1000.0);
        v.zoom_at_pixel(50.0, 0.5);
        v.begin_interact(1100.0);
        v.zoom_at_pixel(50.0, 0.5);
        v.begin_interact(1300.0);
        v.zoom_at_pixel(50.0, 0.5);
        let (b_start, b_tpp) = (v.start_ticks(), v.ticks_per_pixel());
        // Gesture 2, past the window → second entry (window B).
        v.begin_interact(2000.0);
        v.zoom_at_pixel(50.0, 0.5);

        assert!(v.undo(3000.0));
        v.tick(3000.0 + ZOOM_ANIM_MS);
        assert_close(v.start_ticks(), b_start);
        assert_close(v.ticks_per_pixel(), b_tpp);

        assert!(v.undo(4000.0));
        v.tick(4000.0 + ZOOM_ANIM_MS);
        assert_close(v.start_ticks(), 0.0);
        assert_close(v.ticks_per_pixel(), 10.0); // back to the original fit

        assert!(!v.undo(5000.0)); // stack exhausted
    }

    #[test]
    fn history_dedups_identical_window_and_undo_skips_no_op_records() {
        let mut v = fit_vp();
        // A wheel that hits the pan clamp and changes nothing still records the
        // window once; the duplicate is deduped and undo skips the no-op.
        v.begin_interact(1000.0);
        v.pan_by_pixels(-100.0); // clamped: still at fit
        v.begin_interact(2000.0); // identical window → deduped
        assert!(v.can_undo());
        assert!(!v.undo(3000.0)); // only record equals current view → no-op
        assert!(!v.can_undo());
    }

    #[test]
    fn undo_restores_pre_action_window() {
        let mut v = fit_vp();
        assert!(v.apply_range(100.0, 300.0, 0.0)); // pushes the fit window
        assert!(v.apply_range(400.0, 500.0, 10.0)); // pushes [100,300]
        assert!(v.undo(1000.0));
        v.tick(1000.0 + ZOOM_ANIM_MS);
        assert_close(v.start_ticks(), 100.0);
        assert_close(v.ticks_per_pixel(), 2.0);
    }

    // --- needed_window (repack policy) ---------------------------------------

    /// end 10000 over 100 px, explicit window [2000, 3000] (tpp 10).
    fn repack_vp() -> Viewport {
        let mut v = Viewport::new();
        v.reset_for_trace(10000, None);
        v.set_width(100.0);
        v.tick(0.0);
        assert!(v.apply_range(2000.0, 3000.0, 0.0));
        v
    }

    fn packed(start: u64, end: u64, tpp: f64) -> Option<PackedWindow> {
        Some(PackedWindow { start, end, tpp })
    }

    #[test]
    fn needed_window_initial_pack_adds_one_screen_margin_each_side() {
        let v = repack_vp();
        // visible = 1000 → margin M = 1000 each side, clamped to the trace.
        assert_eq!(v.needed_window(None, 10000), Some((1000, 4000)));
    }

    #[test]
    fn needed_window_interior_view_does_not_repack() {
        let v = repack_vp();
        assert_eq!(v.needed_window(packed(1000, 4000, 10.0), 10000), None);
    }

    #[test]
    fn needed_window_left_guard_band_triggers() {
        let mut v = repack_vp();
        // G = 500: repack once start crosses packed.start + 500.
        assert!(v.apply_range(1499.0, 2499.0, 1.0));
        assert_eq!(v.needed_window(packed(1000, 4000, 10.0), 10000), Some((499, 3499)));
        assert!(v.apply_range(1501.0, 2501.0, 2.0));
        assert_eq!(v.needed_window(packed(1000, 4000, 10.0), 10000), None);
    }

    #[test]
    fn needed_window_right_guard_band_triggers() {
        let mut v = repack_vp();
        assert!(v.apply_range(2501.0, 3501.0, 1.0));
        assert_eq!(v.needed_window(packed(1000, 4000, 10.0), 10000), Some((1501, 4501)));
        assert!(v.apply_range(2499.0, 3499.0, 2.0));
        assert_eq!(v.needed_window(packed(1000, 4000, 10.0), 10000), None);
    }

    #[test]
    fn needed_window_edge_clauses_gate_at_trace_bounds() {
        let mut v = repack_vp();
        // Visible left edge sitting on a packed window clamped at 0 → no retrigger.
        assert!(v.apply_range(0.0, 1000.0, 1.0));
        assert_eq!(v.needed_window(packed(0, 2000, 10.0), 10000), None);
        // Same at the trace end.
        assert!(v.apply_range(9000.0, 10000.0, 2.0));
        assert_eq!(v.needed_window(packed(8000, 10000, 10.0), 10000), None);
    }

    #[test]
    fn needed_window_zoom_out_density_clause() {
        let mut v = repack_vp();
        // Packed covers the whole trace, but at 3× finer density than the view:
        // tpp 30 > 10 × ZOOM_OUT_FACTOR → repack (bucket density depends on tpp).
        assert!(v.apply_range(0.0, 3000.0, 1.0));
        assert_eq!(v.needed_window(packed(0, 10000, 10.0), 10000), Some((0, 6000)));
        // At 1.4× the packed density it stays inside the hysteresis (packed
        // window chosen so no other clause fires).
        assert!(v.apply_range(0.0, 1400.0, 2.0));
        assert_eq!(v.needed_window(packed(0, 3000, 10.0), 10000), None);
        // …and 1.6× repacks.
        assert!(v.apply_range(0.0, 1600.0, 3.0));
        assert_eq!(v.needed_window(packed(0, 3000, 10.0), 10000), Some((0, 3200)));
    }

    #[test]
    fn needed_window_shrink_clause_rewindows_after_zoom_in() {
        let mut v = repack_vp();
        // Zoomed in to a 100-tick view: packed span 10000 > 6 × 100 → re-window.
        assert!(v.apply_range(5000.0, 5100.0, 1.0));
        assert_eq!(v.needed_window(packed(0, 10000, 1.0), 10000), Some((4900, 5200)));
    }

    #[test]
    fn query_window_clamps_to_trace() {
        let mut v = repack_vp();
        assert!(v.apply_range(100.0, 1100.0, 1.0));
        assert_eq!(v.query_window(10000), (0, 2100));
        assert!(v.apply_range(8900.0, 9900.0, 2.0));
        assert_eq!(v.query_window(10000), (7900, 10000));
    }
}
