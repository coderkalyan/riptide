//! Frame-geometry instance types — the CPU-side specs the geometry builder
//! (riptide-core) hands to the batch renderers (riptide-render). Field sets
//! mirror the TS batch specs (`gpu/lines.ts LineSpec`, `gpu/rect.ts RectSpec`,
//! `gpu/text.ts writeGlyph`, `gpu/frame.ts PillRange`). All coords are CSS px.

use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LineInstance {
    /// CSS px; time-aligned lines are LEFT-aligned to their tick (see the
    /// vertical-line alignment contract in CLAUDE.md).
    pub x: f32,
    /// Packed rgba (little-endian r,g,b,a — `packRgba`).
    pub color: u32,
    pub dashed: bool,
    /// Extend to y=0 instead of starting inside the flag pill (hover guide).
    pub full_height: bool,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RectInstance {
    pub x: f32,
    pub y: f32,
    pub w: f32,
    pub h: f32,
    pub color: u32,
    pub crosshatch: bool,
    /// 3 CSS px corner radius (matches DOM .flag border-radius).
    pub rounded: bool,
    /// Chevron arrowhead instead of a solid rect.
    pub caret: bool,
    /// Caret points right (">"); else left ("<").
    pub caret_right: bool,
    pub square_bottom_left: bool,
    pub square_bottom_right: bool,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GlyphInstance {
    pub x: f32,
    pub y: f32,
    /// Char code; ASCII 0x20..=0x7e plus the middle dot 0x00b7.
    pub ch: u32,
    pub color: u32,
    /// Use the small atlas (ruler/labels) instead of the large one.
    pub small: bool,
}

/// One pill's slice of the shared pill rect/text buffers — drawn per pill via
/// firstInstance so each pill's rect occludes earlier pills' text.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PillRange {
    pub rect_start: u32,
    pub rect_count: u32,
    pub text_start: u32,
    pub text_count: u32,
}

/// A marker (or cursor) pill's hit-test box, produced by the geometry builder
/// and consumed by the input controller's grab test. `line_x` is the marker
/// line's left edge; the visual center is `line_x + LINE_HALF_CSS`.
#[derive(Clone, Copy, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MarkerHit {
    /// Marker id; u32::MAX = the cursor pill.
    pub id: u32,
    pub x0: f32,
    pub x1: f32,
    pub line_x: f32,
}

/// Glyph-cell metrics of one atlas size (mirrors `gpu/text.ts GlyphCell`).
#[derive(Clone, Copy, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CellMetrics {
    pub width_px: f32,
    pub height_px: f32,
    pub ascent_px: f32,
    /// Cap-height midline offset from cell top, CSS px.
    pub midline_px: f32,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TextMetrics {
    pub cell_lg: CellMetrics,
    pub cell_sm: CellMetrics,
}

/// A zoomed-out "busy band": a run of buckets with ≥1 transition each,
/// rendered as a solid/crosshatch rect instead of per-transition segments.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BucketBand {
    pub row: u32,
    pub t_start: u64,
    pub t_end: u64,
    pub has_x: bool,
    pub has_z: bool,
    /// Row is multi-bit (pill-toned band) vs single-bit (rail-spanning band).
    pub multi: bool,
}

/// Everything one frame draws besides the digital segment pipelines.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FrameGeometry {
    pub lines_bg: Vec<LineInstance>,
    pub rects_bg: Vec<RectInstance>,
    pub lines_fg: Vec<LineInstance>,
    pub glyphs: Vec<GlyphInstance>,
    pub pill_rects: Vec<RectInstance>,
    pub pill_glyphs: Vec<GlyphInstance>,
    pub pill_ranges: Vec<PillRange>,
    pub marker_hits: Vec<MarkerHit>,
    pub bucket_bands: Vec<BucketBand>,
}
