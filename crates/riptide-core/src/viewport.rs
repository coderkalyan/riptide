//! The viewport controller: pan/zoom/fit, eased zoom animation, view history,
//! and the repack-window policy. Port of `src/renderer/wave/viewport.ts` plus
//! the over-fetch/guard-band window logic from `WaveCanvas.tsx`.
//!
//! OWNED BY UNIT U4 (with `input.rs`). The unit owns this API's internals and
//! may extend it; `Engine` (wired at integration, U15) is the only consumer,
//! so additions are safe. Time is injected (`now_ms`) — no wall-clock reads —
//! for deterministic tests and wasm cleanliness.

#[derive(Default)]
pub struct Viewport {
    _private: (),
}

impl Viewport {
    pub fn new() -> Self {
        Self::default()
    }

    /// Seed/auto-fit for a fresh trace (port of `resetForTrace`).
    pub fn reset_for_trace(&mut self, _end_ticks: u64, _initial: Option<(f64, f64)>) {
        todo!("U4")
    }

    /// Canvas width changed: preserve the logical window (port of `setWidth`).
    pub fn set_width(&mut self, _width_px: f32) {
        todo!("U4")
    }

    pub fn start_ticks(&self) -> f64 {
        todo!("U4")
    }

    pub fn ticks_per_pixel(&self) -> f64 {
        todo!("U4")
    }

    pub fn width_px(&self) -> f32 {
        todo!("U4")
    }

    /// `xForTick`: logical time → CSS-px x (left edge; see the alignment
    /// contract in CLAUDE.md).
    pub fn x_for_tick(&self, _t: f64) -> f32 {
        todo!("U4")
    }

    /// Inverse of `x_for_tick`, including the hover-centering bias
    /// (`tickAtClientX` semantics).
    pub fn tick_at_x(&self, _x: f32) -> f64 {
        todo!("U4")
    }

    pub fn pan_by_px(&mut self, _dx: f32) {
        todo!("U4")
    }

    /// Wheel zoom anchored at x (port of the eased zoom-at-pointer).
    pub fn zoom_at(&mut self, _x: f32, _delta_y: f32) {
        todo!("U4")
    }

    pub fn zoom_to_range(&mut self, _start: f64, _end: f64) {
        todo!("U4")
    }

    pub fn fit(&mut self, _end_ticks: u64) {
        todo!("U4")
    }

    pub fn undo(&mut self) -> bool {
        todo!("U4")
    }

    /// Advances the zoom animation; returns true if the view changed (frame is
    /// dirty) and whether the gesture settled this tick.
    pub fn tick(&mut self, _now_ms: f64) -> ViewportTick {
        todo!("U4")
    }

    /// External set (JS `setViewRange` during doc sync / sidecar load).
    pub fn set_view_range(&mut self, _start: f64, _end: f64) {
        todo!("U4")
    }

    /// The repack-window policy (over-fetch margin + guard band + shrink
    /// clauses from WaveCanvas): given the currently packed window, the new
    /// `[q_start, q_end]` to pack, or None if the packed window still covers.
    pub fn needed_window(&self, _packed: Option<(u64, u64)>, _end_ticks: u64) -> Option<(u64, u64)> {
        todo!("U4")
    }
}

#[derive(Clone, Copy, Debug, Default)]
pub struct ViewportTick {
    pub dirty: bool,
    /// Pan/zoom gesture or animation finished this tick → emit a settled
    /// ViewportChanged (JS persists the window).
    pub settled: bool,
}
