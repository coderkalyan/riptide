//! Frame-geometry builder: ruler bands/notches, dead-zone crosshatch, grid,
//! cursor/marker/hover lines, span arrows, reset bands, pill rects + glyph
//! placement. Port of the `WaveCanvas.tsx` per-frame geometry body on top of
//! `format::time` + `clock` (TS line numbers below cite WaveCanvas.tsx at the
//! migration seed).
//!
//! OWNED BY UNIT U5. `FrameState` is the unit's to extend (Engine adapts at
//! integration); `build_frame_geometry` is the frozen cross-unit entry.
//!
//! All coordinates are CSS px (see the DPR contract in CLAUDE.md) and all
//! intermediate math is f64, mirroring JS number semantics; values are cast to
//! f32 only when written into the contract instances.
//!
//! Vertical-line alignment contract: time-aligned lines (notches, grid,
//! cursor, markers) are LEFT-aligned — `x = x_for_tick(t)`, extending
//! LINE_THICKNESS_CSS to the right (lines.wgsl does the extension). The hover
//! guide is drawn at the tick it is given; the *input* side biases that tick
//! left by LINE_HALF_CSS so it renders centered on the pointer. Pill anchoring
//! and `MarkerHit.line_x + LINE_HALF_CSS` reach the visual line center.

use std::collections::HashMap;

use riptide_contract::doc::MarkerDto;
use riptide_contract::geometry::{
    BucketBand, CellMetrics, FrameGeometry, GlyphInstance, LineInstance, MarkerHit, PillRange,
    RectInstance, TextMetrics,
};
use riptide_contract::spec::{ClockGrid, RowSpec};

use crate::format::time::{
    clock_edges_between, clock_ruler_ticks, dynamic_ruler_ticks, format_clock_whole, format_time,
    js_round, ruler_spacing,
};

// ---- constants.ts replicas (CSS px; NOT multiplied by dpr) -----------------

/// Default active-signal / ruler row height (`constants.ts ROW_HEIGHT_CSS`).
pub const ROW_HEIGHT_CSS: f32 = 28.0;
/// Default extra gap below a row carrying `divider_below`
/// (`constants.ts DIVIDER_HEIGHT_CSS`).
pub const DIVIDER_HEIGHT_CSS: f32 = 16.0;
/// Vertical-line thickness — MUST match `thickness` in lines.wgsl
/// (`constants.ts LINE_THICKNESS_CSS`).
pub const LINE_THICKNESS_CSS: f32 = 2.5;
pub const LINE_HALF_CSS: f32 = LINE_THICKNESS_CSS * 0.5;
/// Ruler notch height (`constants.ts NOTCH_HEIGHT`).
pub const NOTCH_HEIGHT: f32 = 12.0;
/// Bottom ruler band height (`constants.ts BOTTOM_RULER_HEIGHT`).
pub const BOTTOM_RULER_HEIGHT: f32 = 24.0;
/// Marker pill/line pool size (`constants.ts MAX_MARKERS`).
pub const MAX_MARKERS: usize = 16;
/// Per-batch glyph cap (`gpu/text.ts MAX_GLYPHS`).
pub const MAX_GLYPHS: usize = 4096;
/// `MarkerHit.id` of the cursor pill (markers use their own u32 ids).
pub const CURSOR_HIT_ID: u32 = u32::MAX;

// ---- palette.ts replicas (packed 0xAABBGGRR, LE channels) ------------------

/// `gpu/text.ts packRgba` — little-endian channel packing (r in the LSB).
pub const fn pack_rgba(r: u8, g: u8, b: u8, a: u8) -> u32 {
    ((a as u32) << 24) | ((b as u32) << 16) | ((g as u32) << 8) | r as u32
}

pub const PANEL_2: u32 = pack_rgba(0x22, 0x25, 0x2a, 0xff);
pub const BORDER: u32 = pack_rgba(0x2f, 0x33, 0x3a, 0xff);
pub const HOT: u32 = pack_rgba(0xf0, 0x6b, 0x5b, 0xff);
pub const TEXT_SECONDARY: u32 = pack_rgba(0xc4, 0xc3, 0xbb, 0xff);
pub const ON_ACCENT: u32 = pack_rgba(0x0f, 0x1a, 0x09, 0xff);
pub const GRID_GRAY: u32 = pack_rgba(0x86, 0x8c, 0x96, 0x70);
pub const DEAD_ZONE_GRAY: u32 = pack_rgba(0x78, 0x7c, 0x86, 0x70);
pub const RESET_TEXT: u32 = pack_rgba(0xf0, 0x6b, 0x5b, 0xff);
pub const NOTCH_COLOR: u32 = pack_rgba(0x86, 0x8c, 0x96, 0xff);

/// Alpha for reset crosshatch bands — translucent so the ruler notches +
/// dashed grid read through (WaveCanvas.tsx:32).
const RESET_BAND_ALPHA: u32 = 0x60;

/// Bucket-band x/z tints — the digital shaders' `x_color`/`z_color`
/// (digital.wgsl fs_*: (0.9608, 0.4471, 0.4471) / (1.0, 0.863, 0.0)).
const BUCKET_X_TINT: u32 = pack_rgba(0xf5, 0x72, 0x72, 0xff);
const BUCKET_Z_TINT: u32 = pack_rgba(0xff, 0xdc, 0x00, 0xff);
/// Multi-bit pill fill alpha (digital.wgsl fs_multi shade_alpha 0.7).
const BUCKET_MULTI_ALPHA: u32 = 0xb3;
/// Segments inset 4 CSS px vertically within their row
/// (digital.wgsl vs_main `ygap_px`); bands match so they line up.
const SEGMENT_Y_GAP: f64 = 4.0;

/// One reset-role row's visible HIGH spans (from `clock::reset_high_spans`
/// over the visible window, computed by the engine) plus the row's packed
/// color. Replaces WaveCanvas's per-frame `resetHighSpans` native calls
/// (WaveCanvas.tsx:484-494) — the geometry builder has no trace access.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct ResetRowSpans {
    pub color: u32,
    /// `(t_start, t_end)` intervals, clamped to the visible window.
    pub spans: Vec<(u64, u64)>,
}

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
    /// Decimal places for absolute time labels (`format::time::time_decimals`
    /// of the trace timescale; the TS module-const TIME_DECIMALS).
    pub time_decimals: u32,
    /// Per reset-role row: visible high spans + color (see [`ResetRowSpans`]).
    pub reset_spans: Vec<ResetRowSpans>,
}

/// Blend the colors of the reset signals covering one sub-interval into a
/// single translucent packed rgba. One signal → its own color; several
/// overlapping → their average (WaveCanvas.tsx:36-42 `resetBandColor`).
fn reset_band_color(cols: &[u32]) -> u32 {
    let (mut r, mut g, mut b) = (0u32, 0u32, 0u32);
    for &c in cols {
        r += c & 0xff;
        g += (c >> 8) & 0xff;
        b += (c >> 16) & 0xff;
    }
    let n = cols.len() as u32;
    // `(x / n) | 0` in the TS — truncating division.
    (RESET_BAND_ALPHA << 24) | ((b / n) << 16) | ((g / n) << 8) | (r / n)
}

/// `WaveCanvas.tsx:218-230 writeText`: one glyph per renderable char (ASCII
/// 0x20..=0x7e plus the middle dot), advancing by the cell width even across
/// skipped chars, capped at MAX_GLYPHS per batch.
fn write_text(
    out: &mut Vec<GlyphInstance>,
    metrics: &TextMetrics,
    x: f64,
    y: f64,
    text: &str,
    color: u32,
    small: bool,
) {
    let cell = if small { &metrics.cell_sm } else { &metrics.cell_lg };
    for (k, ch) in text.chars().enumerate() {
        if out.len() >= MAX_GLYPHS {
            break;
        }
        let code = ch as u32;
        if !(0x20..=0x7e).contains(&code) && code != 0xb7 {
            continue;
        }
        out.push(GlyphInstance {
            x: (x + k as f64 * cell.width_px as f64) as f32,
            y: y as f32,
            ch: code,
            color,
            small,
        });
    }
}

/// A pending small-font label on the bottom ruler (span-arrow + RESET text),
/// flushed into the glyph batch after the ruler tick labels
/// (WaveCanvas.tsx:386 `rulerArrowLabels`, flushed at :599-601).
struct ArrowLabel {
    x: f64,
    y: f64,
    text: String,
    color: u32,
}

/// `WaveCanvas.tsx:410-468 drawSpanArrow` — the bottom-ruler span arrow
/// between two x positions, with its three layouts by gap width:
///  1. label inside the arrow (split shaft) — widest spans,
///  2. arrow inside, label to the side (full shaft) — medium spans,
///  3. chevrons outside pointing in, label to the side — narrowest.
#[allow(clippy::too_many_arguments)]
fn draw_span_arrow(
    rects: &mut Vec<RectInstance>,
    labels: &mut Vec<ArrowLabel>,
    cell_sm: &CellMetrics,
    canvas_w: f64,
    arrow_y: f64,
    left_x: f64,
    right_x: f64,
    label: &str,
    color: u32,
) {
    let (head_w, head_h, shaft_h, gap) = (12.0, 10.0, 2.0, 6.0);
    let text_w = label.chars().count() as f64 * cell_sm.width_px as f64;
    let label_pad = 5.0;
    let label_y = js_round(arrow_y - cell_sm.midline_px as f64);

    let draw_shaft = |rects: &mut Vec<RectInstance>, x0: f64, x1: f64| {
        if x1 <= x0 {
            return;
        }
        rects.push(RectInstance {
            x: x0 as f32,
            y: (arrow_y - shaft_h * 0.5) as f32,
            w: (x1 - x0) as f32,
            h: shaft_h as f32,
            color,
            ..Default::default()
        });
    };
    let draw_head = |rects: &mut Vec<RectInstance>, center_x: f64, points_right: bool| {
        rects.push(RectInstance {
            x: (center_x - head_w * 0.5) as f32,
            y: (arrow_y - head_h * 0.5) as f32,
            w: head_w as f32,
            h: head_h as f32,
            color,
            caret: true,
            caret_right: points_right,
            ..Default::default()
        });
    };
    let push_label = |labels: &mut Vec<ArrowLabel>, x: f64| {
        labels.push(ArrowLabel { x: js_round(x), y: label_y, text: label.to_string(), color });
    };
    let push_side_label = |labels: &mut Vec<ArrowLabel>, x_r: f64, x_l: f64| {
        let right = x_r + label_pad;
        let x = if right + text_w <= canvas_w - 2.0 { right } else { x_l - label_pad - text_w };
        push_label(labels, x);
    };

    let left_apex = left_x + gap;
    let right_apex = right_x - gap;
    let inside_room = right_apex - left_apex;
    let span = right_x - left_x;
    // 1↔2 is governed by the on-screen gap from the mock sidecar's manually
    // placed cursor/marker plus a geometric check so a long label never
    // spills; 2↔3 stays a much smaller threshold (WaveCanvas.tsx:440-447).
    const INSIDE_LABEL_MIN_SPAN_PX: f64 = 85.0;
    let min_shaft_clear = 2.0;
    if inside_room - head_w >= min_shaft_clear {
        let mid_x = (left_apex + right_apex) * 0.5;
        let split_l = mid_x - text_w * 0.5 - label_pad;
        let split_r = mid_x + text_w * 0.5 + label_pad;
        let label_fits = span >= INSIDE_LABEL_MIN_SPAN_PX
            && split_l > left_apex + 2.0
            && split_r < right_apex - 2.0;
        if label_fits {
            draw_shaft(rects, left_apex, split_l);
            draw_shaft(rects, split_r, right_apex);
            push_label(labels, mid_x - text_w * 0.5);
        } else {
            draw_shaft(rects, left_apex, right_apex);
            push_side_label(labels, right_apex + head_w * 0.5, left_apex - head_w * 0.5);
        }
        draw_head(rects, left_apex, false);
        draw_head(rects, right_apex, true);
    } else {
        draw_head(rects, left_x - gap, true);
        draw_head(rects, right_x + gap, false);
        push_side_label(labels, right_x + gap + head_w * 0.5, left_x - gap - head_w * 0.5);
    }
}

/// `WaveCanvas.tsx:612-636 addFlag`: one pill (rect + glyphs) appended into
/// the shared pill buffers, its slice recorded as a PillRange. The pill slides
/// across its anchor line near the right edge (t: 0 → line on the pill's
/// left, 1 → on its right) and clamps inside the canvas. Returns `(x0, x1)`.
fn add_flag(
    geom: &mut FrameGeometry,
    metrics: &TextMetrics,
    canvas_w: f64,
    x: f64,
    text: &str,
    color: u32,
) -> (f64, f64) {
    let cell_sm = &metrics.cell_sm;
    let pad_x = 5.0;
    let pill_h = 14.0;
    let pill_w = text.chars().count() as f64 * cell_sm.width_px as f64 + pad_x * 2.0;
    let flip_start = canvas_w - pill_w;
    let t = ((x - flip_start) / pill_w).min(1.0).max(0.0);
    let anchor = x + t * LINE_THICKNESS_CSS as f64;
    // min-then-max like the TS, so a pill wider than the canvas pins to 0.
    let pill_x = (anchor - t * pill_w).min(canvas_w - pill_w).max(0.0);
    let pill_y = 0.0;
    let rect_start = geom.pill_rects.len() as u32;
    let line_on_right = t >= 0.5;
    geom.pill_rects.push(RectInstance {
        x: pill_x as f32,
        y: pill_y as f32,
        w: pill_w as f32,
        h: pill_h as f32,
        color,
        rounded: true,
        square_bottom_left: !line_on_right,
        square_bottom_right: line_on_right,
        ..Default::default()
    });
    let text_start = geom.pill_glyphs.len() as u32;
    write_text(
        &mut geom.pill_glyphs,
        metrics,
        js_round(pill_x + pad_x),
        js_round(pill_y + pill_h * 0.5 - cell_sm.midline_px as f64),
        text,
        ON_ACCENT,
        true,
    );
    let text_count = geom.pill_glyphs.len() as u32 - text_start;
    geom.pill_ranges.push(PillRange { rect_start, rect_count: 1, text_start, text_count });
    (pill_x, pill_x + pill_w)
}

/// Per-row vertical layout walk (WaveCanvas `applyRowLayout`/`updateHover`,
/// :133-141/:692-700): rows stack from the ruler band; height = the row's
/// override or ROW_HEIGHT_CSS; a `divider_below` row adds its divider gap.
/// Returns row index → (y, height).
fn row_layout(rows: &[RowSpec], wave_y_offset: f64) -> HashMap<u32, (f64, f64)> {
    let mut map = HashMap::with_capacity(rows.len());
    let mut y = wave_y_offset;
    for r in rows {
        let h = r.height.unwrap_or(ROW_HEIGHT_CSS) as f64;
        map.insert(r.row, (y, h));
        y += h
            + if r.divider_below {
                r.divider_height.unwrap_or(DIVIDER_HEIGHT_CSS) as f64
            } else {
                0.0
            };
    }
    map
}

/// Builds one frame's non-segment geometry (the WaveCanvas.tsx rAF frame
/// body, :259-651, minus GPU calls / input / repack policy).
pub fn build_frame_geometry(state: &FrameState) -> FrameGeometry {
    let mut geom = FrameGeometry::default();
    let tpp = state.ticks_per_pixel;
    let canvas_w = state.width as f64;
    let canvas_h = state.height as f64;
    // WaveCanvas skips the frame when there's nothing to draw into (:285).
    if canvas_w <= 0.0 || tpp <= 0.0 {
        return geom;
    }
    let start_ticks = state.start_ticks;
    let ruler_h = state.wave_y_offset as f64; // rulerHeightCSS (:276, :376)
    let wave_h = (canvas_h - ruler_h).max(0.0);
    let timeline_px = canvas_w;
    let visible_ticks = timeline_px * tpp;
    let view_end = start_ticks + visible_ticks;
    let cursor = state.cursor;
    // Clock-aligned mode is on only when a valid detected/overridden grid
    // exists (:366-368). period > 0 is a Rust-side loop guard (detection
    // always emits ≥ 1; a zero override must not hang the ruler loop).
    let grid = state.clock_grid;
    let clock_mode =
        state.clock_anchor && grid.is_some_and(|g| g.valid && g.period > 0.0);
    let x_for_tick = |t: f64| (t - start_ticks) / tpp; // :369

    let data_end_px = x_for_tick(state.end_ticks as f64);
    let dead_start_px = timeline_px.min(data_end_px);
    let notch_y = ruler_h - NOTCH_HEIGHT as f64;
    let bottom_ruler_h = BOTTOM_RULER_HEIGHT as f64;
    let bottom_ruler_top = canvas_h - bottom_ruler_h;
    let ruler = if clock_mode {
        clock_ruler_ticks(start_ticks, visible_ticks, &grid.unwrap())
    } else {
        dynamic_ruler_ticks(start_ticks, visible_ticks)
    };
    let mut arrow_labels: Vec<ArrowLabel> = Vec::new();

    // ---- rects_bg: ruler bands + notches + dead zone (:389-408) ------------
    geom.rects_bg.push(RectInstance {
        x: 0.0,
        y: 0.0,
        w: canvas_w as f32,
        h: ruler_h as f32,
        color: PANEL_2,
        ..Default::default()
    });
    geom.rects_bg.push(RectInstance {
        x: 0.0,
        y: (ruler_h - 1.0) as f32,
        w: canvas_w as f32,
        h: 1.0,
        color: BORDER,
        ..Default::default()
    });
    for &t in &ruler.ticks {
        geom.rects_bg.push(RectInstance {
            x: x_for_tick(t) as f32,
            y: notch_y as f32,
            w: LINE_THICKNESS_CSS,
            h: NOTCH_HEIGHT,
            color: NOTCH_COLOR,
            ..Default::default()
        });
    }
    geom.rects_bg.push(RectInstance {
        x: dead_start_px as f32,
        y: ruler_h as f32,
        w: (canvas_w - dead_start_px) as f32,
        h: wave_h as f32,
        color: DEAD_ZONE_GRAY,
        crosshatch: true,
        ..Default::default()
    });
    geom.rects_bg.push(RectInstance {
        x: 0.0,
        y: bottom_ruler_top as f32,
        w: canvas_w as f32,
        h: bottom_ruler_h as f32,
        color: PANEL_2,
        ..Default::default()
    });
    geom.rects_bg.push(RectInstance {
        x: 0.0,
        y: bottom_ruler_top as f32,
        w: canvas_w as f32,
        h: 1.0,
        color: BORDER,
        ..Default::default()
    });
    for &t in &ruler.ticks {
        geom.rects_bg.push(RectInstance {
            x: x_for_tick(t) as f32,
            y: (canvas_h - NOTCH_HEIGHT as f64) as f32,
            w: LINE_THICKNESS_CSS,
            h: NOTCH_HEIGHT,
            color: NOTCH_COLOR,
            ..Default::default()
        });
    }
    let arrow_y = bottom_ruler_top + (bottom_ruler_h - NOTCH_HEIGHT as f64) * 0.5; // :409

    // ---- reset bands: boundary sweep over disjoint sub-intervals (:470-539).
    // Each reset signal contributes a band per visible HIGH interval, in its
    // own color; overlaps merge into disjoint rects (one crosshatch rect per
    // screen column — no translucent stacking) with averaged colors, and the
    // RESET labels coalesce to one per contiguous covered run.
    {
        struct ResetEv {
            t: u64,
            d: i32,
            color: u32,
        }
        let mut events: Vec<ResetEv> = Vec::new();
        for rr in &state.reset_spans {
            for &(t_start, t_end) in &rr.spans {
                if t_end <= t_start {
                    continue;
                }
                events.push(ResetEv { t: t_start, d: 1, color: rr.color });
                events.push(ResetEv { t: t_end, d: -1, color: rr.color });
            }
        }
        if !events.is_empty() {
            // Starts before ends at the same tick so abutting spans of the
            // same signal merge into one cluster rather than blinking off.
            events.sort_by(|a, b| a.t.cmp(&b.t).then(b.d.cmp(&a.d)));
            let mut active_cols: Vec<u32> = Vec::new(); // multiset
            let mut clusters: Vec<(f64, f64)> = Vec::new();
            let mut run_start: Option<u64> = None;
            let mut run_end: u64 = 0;
            let mut prev_t = events[0].t;
            let mut i = 0;
            while i < events.len() {
                let t = events[i].t;
                if !active_cols.is_empty() && t > prev_t {
                    let x0 = x_for_tick(prev_t as f64);
                    let x1 = x_for_tick(t as f64);
                    geom.rects_bg.push(RectInstance {
                        x: x0 as f32,
                        y: bottom_ruler_top as f32,
                        w: (x1 - x0) as f32,
                        h: bottom_ruler_h as f32,
                        color: reset_band_color(&active_cols),
                        crosshatch: true,
                        ..Default::default()
                    });
                    match run_start {
                        None => run_start = Some(prev_t),
                        Some(rs) => {
                            if prev_t != run_end {
                                clusters
                                    .push((x_for_tick(rs as f64), x_for_tick(run_end as f64)));
                                run_start = Some(prev_t);
                            }
                        }
                    }
                    run_end = t;
                }
                while i < events.len() && events[i].t == t {
                    let ev = &events[i];
                    if ev.d == 1 {
                        active_cols.push(ev.color);
                    } else if let Some(idx) = active_cols.iter().position(|&c| c == ev.color) {
                        active_cols.remove(idx);
                    }
                    i += 1;
                }
                prev_t = t;
            }
            if let Some(rs) = run_start {
                clusters.push((x_for_tick(rs as f64), x_for_tick(run_end as f64)));
            }
            let cell_sm = &state.metrics.cell_sm;
            let label = "RESET";
            let text_w = label.len() as f64 * cell_sm.width_px as f64;
            let label_y = js_round(arrow_y - cell_sm.midline_px as f64);
            for &(x0, x1) in &clusters {
                if x1 - x0 > text_w + 4.0 {
                    arrow_labels.push(ArrowLabel {
                        x: js_round((x0 + x1) * 0.5 - text_w * 0.5),
                        y: label_y,
                        text: label.to_string(),
                        color: RESET_TEXT,
                    });
                }
            }
        }
    }

    // ---- span arrow between the selected marker and the cursor (:541-549) --
    if let Some(sel) = state.selected_marker
        && let Some(arrow_marker) = state.markers.iter().find(|m| m.id == sel)
    {
        let m_x = x_for_tick(arrow_marker.tick) + LINE_HALF_CSS as f64;
        let c_x = x_for_tick(cursor) + LINE_HALF_CSS as f64;
        let span_label = if clock_mode {
            format!("{} clks", clock_edges_between(arrow_marker.tick, cursor, &grid.unwrap()))
        } else {
            format!("{} ns", format_time((cursor - arrow_marker.tick).abs(), state.time_decimals))
        };
        draw_span_arrow(
            &mut geom.rects_bg,
            &mut arrow_labels,
            &state.metrics.cell_sm,
            canvas_w,
            arrow_y,
            m_x.min(c_x),
            m_x.max(c_x),
            &span_label,
            arrow_marker.color,
        );
    }

    // ---- bucket bands → rects_bg (NEW path; bands come from U9's
    // pack::buckets via FrameState). Solid row color for 1-bit rows,
    // pill-toned (the multi shader's 0.7 fill alpha) for multi-bit, x/z tint
    // + crosshatch when the run contains unknowns. Vertical extent matches
    // the digital segments (4 px ygap inset within the row).
    if !state.bucket_bands.is_empty() {
        let layout = row_layout(&state.rows, ruler_h);
        for b in &state.bucket_bands {
            let Some(&(row_y, row_h)) = layout.get(&b.row) else { continue };
            let row_color = state
                .rows
                .iter()
                .find(|r| r.row == b.row)
                .map(|r| r.color)
                .unwrap_or(GRID_GRAY);
            let base = if b.has_x {
                BUCKET_X_TINT
            } else if b.has_z {
                BUCKET_Z_TINT
            } else {
                row_color
            };
            let alpha = if b.multi { BUCKET_MULTI_ALPHA } else { 0xff };
            let x0 = x_for_tick(b.t_start as f64);
            let x1 = x_for_tick(b.t_end as f64);
            geom.rects_bg.push(RectInstance {
                x: x0 as f32,
                y: (row_y + SEGMENT_Y_GAP * 0.5) as f32,
                w: (x1 - x0) as f32,
                h: (row_h - SEGMENT_Y_GAP) as f32,
                color: (base & 0x00ff_ffff) | (alpha << 24),
                crosshatch: b.has_x || b.has_z,
                ..Default::default()
            });
        }
        geom.bucket_bands = state.bucket_bands.clone();
    }

    // ---- lines_bg: dashed grid, decimated like the ruler (:553-569). In
    // clock mode it lands on the detected cycle edges (phase + k·period); in
    // absolute mode it's a plain time grid on "nice" ns spacing.
    {
        let grid_edge0 = if clock_mode { grid.unwrap().phase } else { 0.0 };
        let grid_step_ticks = if clock_mode {
            let g = grid.unwrap();
            js_round(ruler_spacing(visible_ticks / g.period)).max(1.0) * g.period
        } else {
            ruler_spacing(visible_ticks)
        };
        let grid_vis_end = start_ticks + visible_ticks;
        let grid_eps = grid_step_ticks * 1e-6;
        let mut gk = ((start_ticks - grid_edge0) / grid_step_ticks).floor().max(0.0);
        loop {
            let t = grid_edge0 + gk * grid_step_ticks;
            if t > grid_vis_end + grid_eps {
                break;
            }
            geom.lines_bg.push(LineInstance {
                x: x_for_tick(t) as f32,
                color: GRID_GRAY,
                dashed: true,
                full_height: false,
            });
            gk += 1.0;
        }
    }

    // ---- lines_fg: hover guide, marker lines, cursor line (:571-588). Hover
    // first so markers and the cursor paint over it. Bug-compatible cap: the
    // TS counts the hover line against MAX_MARKERS (`fgLineN >= MAX_MARKERS`).
    if let Some((hover_tick, _row)) = state.hover {
        geom.lines_fg.push(LineInstance {
            x: x_for_tick(hover_tick) as f32,
            color: GRID_GRAY,
            dashed: true,
            full_height: true,
        });
    }
    for m in &state.markers {
        if geom.lines_fg.len() >= MAX_MARKERS {
            break;
        }
        geom.lines_fg.push(LineInstance {
            x: x_for_tick(m.tick) as f32,
            color: m.color,
            dashed: state.selected_marker != Some(m.id),
            full_height: false,
        });
    }
    geom.lines_fg.push(LineInstance {
        x: x_for_tick(cursor) as f32,
        color: HOT,
        dashed: false,
        full_height: false,
    });

    // ---- glyphs: ruler tick labels (top + bottom), then the collected
    // bottom-ruler labels (:590-602).
    let ruler_label_y = js_round(ruler_h * 0.5 + 2.0);
    let bottom_label_y = js_round(bottom_ruler_top + bottom_ruler_h * 0.5 + 2.0);
    for i in 0..ruler.ticks.len() {
        let lx = js_round(x_for_tick(ruler.ticks[i]) + 5.0);
        write_text(
            &mut geom.glyphs,
            &state.metrics,
            lx,
            ruler_label_y,
            &ruler.labels[i],
            TEXT_SECONDARY,
            true,
        );
        write_text(
            &mut geom.glyphs,
            &state.metrics,
            lx,
            bottom_label_y,
            &ruler.labels[i],
            TEXT_SECONDARY,
            true,
        );
    }
    for al in &arrow_labels {
        write_text(&mut geom.glyphs, &state.metrics, al.x, al.y, &al.text, al.color, true);
    }

    // ---- pills + hit boxes (:637-649). Selected marker pill drawn last (on
    // top); hit boxes pushed in draw order (the input grab test returns the
    // first hit, like the TS markerAt). The cursor pill is appended with
    // CURSOR_HIT_ID so the input side can recognize (or skip) it.
    let mut ordered: Vec<&MarkerDto> = state.markers.iter().collect();
    if let Some(sel) = state.selected_marker {
        // Stable: non-selected keep order, the selected one moves to the end
        // (the TS `sort((a, b) => Number(a.id===selId) - Number(b.id===selId))`).
        ordered.sort_by_key(|m| m.id == sel);
    }
    let mut mi = 0;
    for m in ordered {
        if mi >= MAX_MARKERS {
            break;
        }
        let line_x = x_for_tick(m.tick);
        let m_label = if clock_mode {
            format_clock_whole(m.tick, &grid.unwrap())
        } else {
            format!("{} ns", format_time(m.tick, state.time_decimals))
        };
        let (x0, x1) =
            add_flag(&mut geom, &state.metrics, canvas_w, line_x, &format!("{} \u{b7} {m_label}", m.name), m.color);
        geom.marker_hits.push(MarkerHit {
            id: m.id,
            x0: x0 as f32,
            x1: x1 as f32,
            line_x: (line_x + LINE_HALF_CSS as f64) as f32,
        });
        mi += 1;
    }
    let cursor_label = if clock_mode {
        format_clock_whole(cursor, &grid.unwrap())
    } else {
        format!("{} ns", format_time(cursor, state.time_decimals))
    };
    let cursor_x = x_for_tick(cursor);
    let (x0, x1) = add_flag(&mut geom, &state.metrics, canvas_w, cursor_x, &cursor_label, HOT);
    geom.marker_hits.push(MarkerHit {
        id: CURSOR_HIT_ID,
        x0: x0 as f32,
        x1: x1 as f32,
        line_x: (cursor_x + LINE_HALF_CSS as f64) as f32,
    });

    geom
}

#[cfg(test)]
mod tests {
    use super::*;

    fn metrics() -> TextMetrics {
        TextMetrics {
            cell_lg: CellMetrics { width_px: 8.0, height_px: 16.0, ascent_px: 12.0, midline_px: 6.0 },
            cell_sm: CellMetrics { width_px: 6.0, height_px: 12.0, ascent_px: 9.0, midline_px: 4.0 },
        }
    }

    /// 1000×400 canvas over [0, 100) ticks (tpp 0.1), trace end 90 → 1 CSS px
    /// per 0.1 tick: x_for_tick(t) = 10·t.
    fn base_state() -> FrameState {
        FrameState {
            start_ticks: 0.0,
            ticks_per_pixel: 0.1,
            width: 1000.0,
            height: 400.0,
            wave_y_offset: 28.0,
            cursor: 42.0,
            end_ticks: 90,
            metrics: metrics(),
            ..Default::default()
        }
    }

    fn marker(id: u32, name: &str, tick: f64, color: u32) -> MarkerDto {
        MarkerDto { id, name: name.to_string(), tick, color }
    }

    fn row_spec(row: u32, color: u32, height: Option<f32>, divider: bool) -> RowSpec {
        use riptide_contract::spec::{PackKind, Radix};
        RowSpec {
            row,
            handle: row.to_string(),
            path: format!("top.s{row}"),
            kind: PackKind::Data,
            polarity: riptide_contract::spec::ClockPolarity::Rising,
            shaded: false,
            mute_handle: None,
            radix: Radix::Hex,
            enums: vec![],
            color,
            hidden: false,
            selected: false,
            height,
            divider_below: divider,
            divider_height: None,
            bit_width: 8,
        }
    }

    #[test]
    fn absolute_ruler_chrome() {
        // WaveCanvas.tsx:383-407. visible = 100 ticks → spacing 10 → ruler
        // ticks 0,10,…,100 (11). Hand math: notch x = 10·t; dead zone starts
        // at x_for_tick(90) = 900.
        let g = build_frame_geometry(&base_state());
        // 2 (band+border) + 11 notches + 1 dead + 2 + 11 = 27 rects.
        assert_eq!(g.rects_bg.len(), 27);
        let r0 = &g.rects_bg[0];
        assert_eq!((r0.x, r0.y, r0.w, r0.h, r0.color), (0.0, 0.0, 1000.0, 28.0, PANEL_2));
        assert_eq!((g.rects_bg[1].y, g.rects_bg[1].h, g.rects_bg[1].color), (27.0, 1.0, BORDER));
        // Top notches sit at y = 28 - 12 = 16, LEFT-aligned on the grid.
        for (k, r) in g.rects_bg[2..13].iter().enumerate() {
            assert_eq!(r.x, (k as f32) * 100.0); // x_for_tick(10k) = 100k
            assert_eq!((r.y, r.w, r.h, r.color), (16.0, LINE_THICKNESS_CSS, 12.0, NOTCH_COLOR));
        }
        // Dead zone: x 900..1000, wave area 28..376+24.
        let dead = &g.rects_bg[13];
        assert_eq!((dead.x, dead.y, dead.w, dead.h), (900.0, 28.0, 100.0, 372.0));
        assert!(dead.crosshatch);
        // Bottom band at y = 400 - 24 = 376; bottom notches at y = 388.
        assert_eq!((g.rects_bg[14].y, g.rects_bg[14].h), (376.0, 24.0));
        assert_eq!(g.rects_bg[16].y, 388.0);

        // Dashed grid (:553-569): absolute mode, step 10 → 11 lines at 100k px.
        assert_eq!(g.lines_bg.len(), 11);
        assert_eq!(g.lines_bg[1].x, 100.0);
        assert!(g.lines_bg[0].dashed && !g.lines_bg[0].full_height);

        // Cursor line only in lines_fg (:586-587): x = x_for_tick(42) = 420.
        assert_eq!(g.lines_fg.len(), 1);
        assert_eq!((g.lines_fg[0].x, g.lines_fg[0].color, g.lines_fg[0].dashed), (420.0, HOT, false));

        // Ruler labels (:591-598): "0 ns"(4) + 9×5 + "100 ns"(6) glyphs, top +
        // bottom = 110. Label x = round(x_for_tick(t)+5); y top = round(16),
        // bottom = round(376+12+2) = 390.
        assert_eq!(g.glyphs.len(), 110);
        assert_eq!((g.glyphs[0].x, g.glyphs[0].y), (5.0, 16.0));
        assert!(g.glyphs[0].small);
        assert_eq!(g.glyphs[0].color, TEXT_SECONDARY);
        assert_eq!((g.glyphs[4].x, g.glyphs[4].y), (5.0, 390.0)); // bottom "0 ns"

        // Cursor pill (:648-649): "42 ns" = 5 chars × 6 + 10 = 40 px wide at
        // x 420 (t = 0 → anchored at the line's left edge).
        assert_eq!(g.pill_rects.len(), 1);
        let p = &g.pill_rects[0];
        assert_eq!((p.x, p.y, p.w, p.h, p.color), (420.0, 0.0, 40.0, 14.0, HOT));
        assert!(p.rounded && p.square_bottom_left && !p.square_bottom_right);
        // Pill text at round(420+5)=425, round(7-4)=3.
        assert_eq!((g.pill_glyphs[0].x, g.pill_glyphs[0].y), (425.0, 3.0));
        assert_eq!(g.pill_glyphs.len(), 5);
        assert_eq!(
            g.pill_ranges[0],
            PillRange { rect_start: 0, rect_count: 1, text_start: 0, text_count: 5 }
        );
        // Cursor hit box, line_x at the visual center (line left edge + half).
        assert_eq!(g.marker_hits.len(), 1);
        let h = &g.marker_hits[0];
        assert_eq!((h.id, h.x0, h.x1, h.line_x), (CURSOR_HIT_ID, 420.0, 460.0, 421.25));
        assert!(h.x0 <= h.line_x && h.line_x <= h.x1);

        assert!(g.rects_bg.iter().all(|r| !r.caret));
        assert!(g.bucket_bands.is_empty());
    }

    #[test]
    fn markers_and_wide_span_arrow() {
        // Marker A @30 (selected), B @70, cursor 42 (WaveCanvas.tsx:541-549).
        // mX = 300+1.25, cX = 420+1.25 → span 120 ≥ 85; leftApex 307.25,
        // rightApex 415.25, insideRoom 108 ≥ 14 → inside-label layout. Label
        // "12 ns" textW = 30; midX = 361.25 → splits 341.25/381.25; shafts
        // (307.25→341.25) and (381.25→415.25); heads centered on the apexes;
        // label x = round(361.25-15) = 346.
        let c1 = pack_rgba(0x4f, 0xd2, 0xbd, 0xff);
        let c2 = pack_rgba(0xe8, 0xb3, 0x4f, 0xff);
        let mut st = base_state();
        st.markers = vec![marker(1, "A", 30.0, c1), marker(2, "B", 70.0, c2)];
        st.selected_marker = Some(1);
        let g = build_frame_geometry(&st);

        // lines_fg (:581-587): markers in store order; selected is solid.
        assert_eq!(g.lines_fg.len(), 3);
        assert_eq!((g.lines_fg[0].x, g.lines_fg[0].dashed), (300.0, false)); // A selected
        assert_eq!((g.lines_fg[1].x, g.lines_fg[1].dashed), (700.0, true));
        assert_eq!(g.lines_fg[2].x, 420.0); // cursor

        // Span-arrow rects appended after the 27 chrome rects: 2 shafts + 2
        // caret heads. arrowY = 376 + (24-12)/2 = 382 → shaft y 381, head y 377.
        assert_eq!(g.rects_bg.len(), 31);
        let s1 = &g.rects_bg[27];
        assert_eq!((s1.x, s1.y, s1.w, s1.h), (307.25, 381.0, 34.0, 2.0));
        let s2 = &g.rects_bg[28];
        assert_eq!((s2.x, s2.w), (381.25, 34.0));
        let h1 = &g.rects_bg[29];
        assert!((h1.caret, h1.caret_right) == (true, false));
        assert_eq!((h1.x, h1.y, h1.w, h1.h), (301.25, 377.0, 12.0, 10.0)); // 307.25-6
        let h2 = &g.rects_bg[30];
        assert!(h2.caret && h2.caret_right);
        assert_eq!(h2.x, 409.25); // 415.25-6
        assert_eq!(s1.color, c1);

        // Glyphs: 110 ruler + "12 ns" (5) = 115; the label starts at x 346,
        // y = round(382-4) = 378.
        assert_eq!(g.glyphs.len(), 115);
        let l0 = &g.glyphs[110];
        assert_eq!((l0.x, l0.y, l0.color), (346.0, 378.0, c1));

        // Pills (:638-647): non-selected first (B), then A (on top), cursor.
        // "B · 70 ns" = 9 chars → w 64.
        assert_eq!(g.pill_ranges.len(), 3);
        assert_eq!(g.marker_hits.len(), 3);
        assert_eq!(
            (g.marker_hits[0].id, g.marker_hits[0].x0, g.marker_hits[0].x1, g.marker_hits[0].line_x),
            (2, 700.0, 764.0, 701.25)
        );
        assert_eq!(
            (g.marker_hits[1].id, g.marker_hits[1].x0, g.marker_hits[1].x1, g.marker_hits[1].line_x),
            (1, 300.0, 364.0, 301.25)
        );
        assert_eq!(g.marker_hits[2].id, CURSOR_HIT_ID);
        for h in &g.marker_hits {
            assert!(h.x0 <= h.line_x && h.line_x <= h.x1, "pill contains its line center");
        }
        // The pill text includes the middle dot (renderable, 9 glyphs).
        assert_eq!(g.pill_ranges[0].text_count, 9);
        assert_eq!(g.pill_glyphs[1].ch, 0xb7);
    }

    #[test]
    fn medium_span_arrow_side_label() {
        // Marker @30 selected, cursor 35: span 50 < 85, insideRoom 38-12 ≥ 2 →
        // full shaft 307.25→345.25 + side label at right: pushSideLabel(351.25,
        // 301.25) → right = 356.25, textW("5 ns") 24 → fits → x = round(356.25).
        let c1 = pack_rgba(10, 20, 30, 0xff);
        let mut st = base_state();
        st.cursor = 35.0;
        st.markers = vec![marker(1, "A", 30.0, c1)];
        st.selected_marker = Some(1);
        let g = build_frame_geometry(&st);
        assert_eq!(g.rects_bg.len(), 27 + 3); // 1 shaft + 2 heads
        let s = &g.rects_bg[27];
        assert_eq!((s.x, s.w), (307.25, 38.0));
        let label = &g.glyphs[110];
        assert_eq!((label.x, label.y), (356.0, 378.0));
    }

    #[test]
    fn overlap_span_arrow_chevrons_out() {
        // Marker @30 selected, cursor 30.6: mX 301.25, cX 307.25 → insideRoom
        // -6 - 12 < 2 → chevrons outside pointing in: heads centered at
        // 301.25-6 = 295.25 (points right) and 307.25+6 = 313.25 (points
        // left); label "1 ns" at round(313.25+6+5) = 324.
        let c1 = pack_rgba(10, 20, 30, 0xff);
        let mut st = base_state();
        st.cursor = 30.6;
        st.markers = vec![marker(1, "A", 30.0, c1)];
        st.selected_marker = Some(1);
        let g = build_frame_geometry(&st);
        assert_eq!(g.rects_bg.len(), 27 + 2); // heads only, no shaft
        let h1 = &g.rects_bg[27];
        assert!(h1.caret && h1.caret_right);
        assert_eq!(h1.x, 295.25 - 6.0);
        let h2 = &g.rects_bg[28];
        assert!(h2.caret && !h2.caret_right);
        assert_eq!(h2.x, 313.25 - 6.0);
        assert_eq!(g.glyphs[110].x, 324.0);
    }

    #[test]
    fn side_label_flips_left_at_canvas_edge() {
        // Marker @95 selected, cursor 99: full-shaft layout near the right
        // edge. pushSideLabel right = 985.25+6+5 = 996.25; 996.25+24 > 998 →
        // label flips left of the arrow: 951.25-6-5-24 = 916.25 → round 916.
        let c1 = pack_rgba(10, 20, 30, 0xff);
        let mut st = base_state();
        st.cursor = 99.0;
        st.markers = vec![marker(1, "A", 95.0, c1)];
        st.selected_marker = Some(1);
        let g = build_frame_geometry(&st);
        let label = g.glyphs.iter().find(|gl| gl.color == c1).unwrap();
        assert_eq!(label.x, 916.0);
    }

    #[test]
    fn clock_aligned_mode() {
        // Grid phase 5 / period 10, anchor on (WaveCanvas.tsx:366-368,
        // :383-385, :556-558): ruler ticks on cycle edges 5,15,…,95 labeled
        // #1..#10; grid lines on the same edges; cursor pill "#4" (cursor 42).
        let mut st = base_state();
        st.clock_anchor = true;
        st.clock_grid = Some(ClockGrid { phase: 5.0, period: 10.0, valid: true });
        st.markers = vec![marker(1, "A", 30.0, pack_rgba(1, 2, 3, 0xff))];
        st.selected_marker = Some(1);
        let g = build_frame_geometry(&st);
        // 2 + 10 notches + 1 + 2 + 10 + arrow(2 shafts? span 120 → inside
        // label "1 clks") = 25 + 4.
        let notch_xs: Vec<f32> =
            g.rects_bg[2..12].iter().map(|r| r.x).collect();
        assert_eq!(notch_xs[0], 50.0); // x_for_tick(5)
        assert_eq!(notch_xs[9], 950.0);
        assert_eq!(g.lines_bg.len(), 10);
        assert_eq!(g.lines_bg[0].x, 50.0);
        // Cursor pill label "#4": floor((42-5+ε)/10)+1 = 4.
        let cur = g.pill_glyphs.len() - 2;
        assert_eq!(g.pill_glyphs[cur].ch, '#' as u32);
        assert_eq!(g.pill_glyphs[cur + 1].ch, '4' as u32);
        // Span label "1 clks": edges in (30,42] = {35? no — ref edges 35? }
        // rising edges at 5+10k; (30,42] holds 35 → wait: edges are at
        // 5,15,25,35 → 35 ∈ (30,42] → 1 edge.
        let span_glyphs: String = g.glyphs[g.glyphs.len() - 6..]
            .iter()
            .map(|gl| char::from_u32(gl.ch).unwrap())
            .collect();
        assert_eq!(span_glyphs, "1 clks");
    }

    #[test]
    fn hover_guide_and_marker_cap() {
        // Hover line first (dashed, full height) (:577-580); the TS counts it
        // against MAX_MARKERS so only 15 of 16 markers draw lines, while all
        // 16 still get pills (:640-647).
        let mut st = base_state();
        st.hover = Some((50.0, 1));
        st.markers = (0..16)
            .map(|i| marker(i, "M", i as f64, pack_rgba(i as u8, 0, 0, 0xff)))
            .collect();
        let g = build_frame_geometry(&st);
        let hov = &g.lines_fg[0];
        assert_eq!((hov.x, hov.color, hov.dashed, hov.full_height), (500.0, GRID_GRAY, true, true));
        // 1 hover + 15 markers + 1 cursor.
        assert_eq!(g.lines_fg.len(), 17);
        // Pills: 16 markers + cursor.
        assert_eq!(g.pill_ranges.len(), 17);
        assert_eq!(g.marker_hits.len(), 17);
    }

    #[test]
    fn pill_flips_at_right_edge() {
        // Cursor 99 → x 990; pill "99 ns" w 40, flipStart 960 → t 0.75 →
        // anchor 991.875 → pillX min(960, 961.875) = 960; line-on-right.
        let mut st = base_state();
        st.cursor = 99.0;
        let g = build_frame_geometry(&st);
        let p = &g.pill_rects[0];
        assert_eq!((p.x, p.w), (960.0, 40.0));
        assert!(p.square_bottom_right && !p.square_bottom_left);
        let h = &g.marker_hits[0];
        assert_eq!((h.x0, h.x1, h.line_x), (960.0, 1000.0, 991.25));
    }

    #[test]
    fn reset_bands_sweep_and_coalesced_label() {
        // Two overlapping resets (:470-539): A high [10,30), B high [20,40) →
        // three DISJOINT crosshatch rects (100..200 A, 200..300 avg(A,B),
        // 300..400 B) and ONE coalesced RESET label over the 100..400 run.
        let ca = pack_rgba(100, 200, 50, 0xff);
        let cb = pack_rgba(200, 100, 150, 0xff);
        let mut st = base_state();
        st.reset_spans = vec![
            ResetRowSpans { color: ca, spans: vec![(10, 30)] },
            ResetRowSpans { color: cb, spans: vec![(20, 40)] },
        ];
        let g = build_frame_geometry(&st);
        assert_eq!(g.rects_bg.len(), 30);
        let b1 = &g.rects_bg[27];
        assert_eq!((b1.x, b1.y, b1.w, b1.h), (100.0, 376.0, 100.0, 24.0));
        assert!(b1.crosshatch);
        assert_eq!(b1.color, (0x60 << 24) | (50 << 16) | (200 << 8) | 100); // A @ 0x60
        let b2 = &g.rects_bg[28];
        assert_eq!((b2.x, b2.w), (200.0, 100.0));
        // Averages truncate: r (100+200)/2=150, g 150, b 100.
        assert_eq!(b2.color, (0x60 << 24) | (100 << 16) | (150 << 8) | 150);
        let b3 = &g.rects_bg[29];
        assert_eq!((b3.x, b3.w), (300.0, 100.0));
        assert_eq!(b3.color, (0x60 << 24) | (150 << 16) | (100 << 8) | 200);
        // One label: "RESET" textW 30 < 300 → centered at round(250-15)=235,
        // y = round(382-4) = 378.
        let labels: Vec<&GlyphInstance> =
            g.glyphs.iter().filter(|gl| gl.color == RESET_TEXT).collect();
        assert_eq!(labels.len(), 5);
        assert_eq!((labels[0].x, labels[0].y), (235.0, 378.0));
    }

    #[test]
    fn reset_bands_disjoint_runs_two_labels() {
        // Disjoint spans → separate clusters, each labeled when wide enough.
        let ca = pack_rgba(100, 200, 50, 0xff);
        let mut st = base_state();
        st.reset_spans = vec![ResetRowSpans { color: ca, spans: vec![(10, 20), (30, 40)] }];
        let g = build_frame_geometry(&st);
        assert_eq!(g.rects_bg.len(), 29); // 2 band rects
        let labels: Vec<&GlyphInstance> =
            g.glyphs.iter().filter(|gl| gl.color == RESET_TEXT).collect();
        assert_eq!(labels.len(), 10); // two "RESET"s
        assert_eq!(labels[0].x, 120.0); // round((100+200)/2 - 15)
        assert_eq!(labels[5].x, 320.0);
        // Abutting spans of one signal merge into one run (starts sort before
        // ends at the same tick).
        st.reset_spans = vec![ResetRowSpans { color: ca, spans: vec![(10, 20), (20, 30)] }];
        let g = build_frame_geometry(&st);
        let labels: Vec<&GlyphInstance> =
            g.glyphs.iter().filter(|gl| gl.color == RESET_TEXT).collect();
        assert_eq!(labels.len(), 5); // one coalesced label
        assert_eq!(labels[0].x, 185.0); // round((100+300)/2 - 15)
    }

    #[test]
    fn bucket_bands_follow_row_layout() {
        // Rows: r0 default 28, r1 height 56 + divider (default 16), r2 →
        // layout y = 28 / 56 / 128. Bands inset 2 px like segments.
        let c1 = pack_rgba(10, 20, 30, 0xff);
        let c2 = pack_rgba(40, 50, 60, 0xff);
        let mut st = base_state();
        st.rows = vec![
            row_spec(0, GRID_GRAY, None, false),
            row_spec(1, c1, Some(56.0), true),
            row_spec(2, c2, None, false),
        ];
        st.bucket_bands = vec![
            BucketBand { row: 1, t_start: 20, t_end: 30, has_x: false, has_z: false, multi: true },
            BucketBand { row: 2, t_start: 40, t_end: 50, has_x: true, has_z: false, multi: false },
        ];
        let g = build_frame_geometry(&st);
        assert_eq!(g.rects_bg.len(), 29);
        let b1 = &g.rects_bg[27];
        assert_eq!((b1.x, b1.y, b1.w, b1.h), (200.0, 58.0, 100.0, 52.0));
        assert_eq!(b1.color, (c1 & 0x00ff_ffff) | (0xb3 << 24)); // pill-toned
        assert!(!b1.crosshatch);
        let b2 = &g.rects_bg[28];
        assert_eq!((b2.x, b2.y, b2.w, b2.h), (400.0, 130.0, 100.0, 24.0));
        assert_eq!(b2.color, BUCKET_X_TINT); // x tint, solid alpha (1-bit)
        assert!(b2.crosshatch);
        assert_eq!(g.bucket_bands, st.bucket_bands); // pass-through copy
    }

    #[test]
    fn degenerate_viewport_is_empty() {
        let mut st = base_state();
        st.width = 0.0;
        assert_eq!(build_frame_geometry(&st), FrameGeometry::default());
        let mut st = base_state();
        st.ticks_per_pixel = 0.0;
        assert_eq!(build_frame_geometry(&st), FrameGeometry::default());
    }

    #[test]
    fn glyph_budget_capped() {
        // A pathological zoom yielding many labels still stays ≤ MAX_GLYPHS.
        let mut st = base_state();
        st.markers = (0..16)
            .map(|i| marker(i, "WWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWW", i as f64, 1))
            .collect();
        let g = build_frame_geometry(&st);
        assert!(g.glyphs.len() <= MAX_GLYPHS);
        assert!(g.pill_glyphs.len() <= MAX_GLYPHS);
    }
}
