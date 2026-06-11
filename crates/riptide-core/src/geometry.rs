//! Frame-geometry builder: ruler bands/notches, dead-zone crosshatch, grid,
//! cursor/marker/hover lines, span arrows, reset bands, pill rects + glyph
//! placement. Port of the `WaveCanvas.tsx` per-frame geometry body on top of
//! `format::time` + `clock`.
//!
//! OWNED BY UNIT U5. `FrameState` is the unit's to extend (Engine adapts at
//! integration); `build_frame_geometry` is the frozen cross-unit entry.

use riptide_contract::doc::MarkerDto;
use riptide_contract::geometry::{BucketBand, FrameGeometry, TextMetrics};
use riptide_contract::spec::{ClockGrid, RowSpec};

/// Everything the geometry builder reads for one frame. CSS px throughout.
#[derive(Clone, Debug, Default)]
pub struct FrameState {
    pub start_ticks: f64,
    pub ticks_per_pixel: f64,
    pub width: f32,
    pub height: f32,
    pub wave_y_offset: f32,
    pub rows: Vec<RowSpec>,
    pub markers: Vec<MarkerDto>,
    pub selected_marker: Option<u32>,
    pub cursor: f64,
    /// (tick, row) under the pointer, if any.
    pub hover: Option<(f64, i32)>,
    pub clock_anchor: bool,
    pub clock_grid: Option<ClockGrid>,
    pub end_ticks: u64,
    pub metrics: TextMetrics,
    /// Busy bands from bucket-mode rows (drawn into rects_bg).
    pub bucket_bands: Vec<BucketBand>,
}

/// Builds one frame's non-segment geometry.
///
/// Seed stub: returns empty geometry (non-panicking) until U5 merges.
pub fn build_frame_geometry(_state: &FrameState) -> FrameGeometry {
    FrameGeometry::default()
}
