//! The engine: one struct owning trace + packer + viewport + input + doc
//! mirror, driving each frame's pack → geometry. The Tauri render thread calls
//! [`Engine::frame`] once per wake; the command layer calls [`Engine::sync_doc`]
//! / [`Engine::on_input`] / [`Engine::resize`] and then wakes the render thread.
//!
//! This is the U15 integration seam: it ties together U2 (pack), U4 (viewport +
//! input), U5 (geometry + clock), and U10 (trace/doc). wgpu lives entirely in
//! the render thread — the engine only produces CPU-side `FrameGeometry` +
//! `PackOutput`, so it stays wasm-clean.
//!
//! Deferred (documented follow-ups, functions exist + tested, not yet wired):
//! bucket-mode downsampling (`pack::buckets`) and reset-crosshatch bands
//! (`clock::reset_high_spans`) — the contract `RowSpec` dropped the old
//! reset/valid role, so reset rows can't be identified until it's re-added.

use riptide_contract::doc::DocSync;
use riptide_contract::geometry::{FrameGeometry, MarkerHit, TextMetrics};
use riptide_contract::gpu::ViewportUniform;
use riptide_contract::ipc::{InputEvent, TraceSummary, UiEvent};
use riptide_contract::pack::PackOutput;
use riptide_contract::spec::ClockGrid;

use crate::geometry::{FrameState, ROW_HEIGHT_CSS, build_frame_geometry};
use crate::input::{InputCtx, InputState};
use crate::pack::Packer;
use crate::viewport::{PackedWindow, Viewport};
use crate::{Error, TraceDb};

/// Top ruler band height (CSS px); waves start below it. Matches the geometry
/// builder's `wave_y_offset` convention (`base_state` uses `ROW_HEIGHT_CSS`).
pub const RULER_HEIGHT_CSS: f32 = ROW_HEIGHT_CSS;

#[derive(Default)]
pub struct Engine {
    pub trace: Option<TraceDb>,
    pub packer: Packer,
    pub viewport: Viewport,
    pub doc: DocSync,
    /// CSS-px canvas size + device pixel ratio (set via `resize`).
    pub canvas: (f32, f32, f32),

    input: InputState,
    /// Glyph metrics from the render thread's text atlas (set once at startup).
    metrics: TextMetrics,
    /// Detected/overridden timebase grid (recomputed on timebase change).
    clock_grid: Option<ClockGrid>,
    /// The tick window currently packed (None = nothing packed yet).
    packed: Option<PackedWindow>,
    /// Pointer hover: (tick, row), or None when off-canvas.
    hover: Option<(f64, i32)>,
    /// Last frame's marker pill hit boxes (input grab-tests against these).
    last_marker_hits: Vec<MarkerHit>,
    /// A doc change requires a repack next frame even if the window is unchanged.
    repack_pending: bool,
    /// Absolute-time decimal places (from the trace timescale).
    time_decimals: u32,
}

/// One frame's outputs for the render loop.
#[derive(Default)]
pub struct FrameResult {
    /// Anything changed — encode + present this frame.
    pub dirty: bool,
    /// The viewport is mid-animation — the loop should re-arm another frame.
    pub animating: bool,
    pub viewport: Option<ViewportUniform>,
    pub geometry: Option<FrameGeometry>,
    /// A repack happened — rebuild segment/scene buffers from this.
    pub repack: Option<PackOutput>,
    pub events: Vec<UiEvent>,
}

impl Engine {
    pub fn new() -> Self {
        Self::default()
    }

    /// Render thread hands over its atlas metrics once, before the first frame.
    pub fn set_text_metrics(&mut self, metrics: TextMetrics) {
        self.metrics = metrics;
    }

    /// Per-row vertical layout for the render thread's `SceneBuffers`
    /// (`set_row_layout`): dense `(y_top, height)` indexed by row, CSS px,
    /// waves stacking below the ruler. Mirrors the geometry builder's
    /// `row_layout`.
    pub fn row_layout(&self) -> Vec<(f32, f32)> {
        let max = self.doc.rows.iter().map(|r| r.row).max().map_or(0, |m| m as usize + 1);
        let mut out = vec![(0.0f32, 0.0f32); max];
        let mut rows = self.doc.rows.clone();
        rows.sort_by_key(|r| r.row);
        let mut y = RULER_HEIGHT_CSS;
        for r in &rows {
            let h = r.height.unwrap_or(ROW_HEIGHT_CSS);
            out[r.row as usize] = (y, h);
            y += h;
            if r.divider_below {
                y += r.divider_height.unwrap_or(crate::geometry::DIVIDER_HEIGHT_CSS);
            }
        }
        out
    }

    /// Per-row packed-rgba colors, indexed by row (for the color buffer).
    pub fn row_colors(&self) -> Vec<u32> {
        let max = self.doc.rows.iter().map(|r| r.row).max().map_or(0, |m| m as usize + 1);
        let mut out = vec![0u32; max];
        for r in &self.doc.rows {
            out[r.row as usize] = r.color;
        }
        out
    }

    /// `(hidden, selected)` per row, indexed by row (for `set_row_flags`).
    pub fn row_flags(&self) -> (Vec<bool>, Vec<bool>) {
        let max = self.doc.rows.iter().map(|r| r.row).max().map_or(0, |m| m as usize + 1);
        let (mut hidden, mut selected) = (vec![false; max], vec![false; max]);
        for r in &self.doc.rows {
            hidden[r.row as usize] = r.hidden;
            selected[r.row as usize] = r.selected;
        }
        (hidden, selected)
    }

    /// Opens a trace, clears the pack cache, resets the viewport.
    pub fn load_trace(&mut self, path: &str) -> Result<TraceSummary, Error> {
        let db = TraceDb::open(path)?;
        let end = db.end_ticks();
        let ts = db.timescale();
        let summary = TraceSummary {
            path: path.to_string(),
            end_ticks: end as f64,
            timescale: ts.map(crate::trace::timescale_dto),
            diagnostics: db.diagnostics(),
        };
        // tide::Timescale carries only one magnitude (no separate VCD time
        // precision), so there are no sub-tick decimals to render — the old
        // TIME_DECIMALS path doesn't apply. Integer-tick labels.
        self.time_decimals = 0;
        self.packer.clear();
        self.packed = None;
        self.repack_pending = true;
        self.clock_grid = None;
        self.trace = Some(db);
        if self.canvas.0 > 0.0 {
            self.viewport.set_width(self.canvas.0 as f64);
        }
        self.viewport.reset_for_trace(end, None);
        Ok(summary)
    }

    /// Applies a JS document sync (repacks next frame). Clock-grid resolution
    /// is the command layer's job (it owns the polarity lookup + emits
    /// `ClockGridChanged`); it stores the result back via [`set_clock_grid`].
    pub fn sync_doc(&mut self, doc: DocSync) -> Vec<UiEvent> {
        if doc.generation < self.doc.generation {
            return Vec::new(); // stale sync raced a canvas-originated change
        }
        self.doc = doc;
        self.repack_pending = true;
        Vec::new()
    }

    /// Stores the resolved timebase grid (used by `frame` geometry + input
    /// snapping). Set by the command layer after `sync_doc`.
    pub fn set_clock_grid(&mut self, grid: Option<ClockGrid>) {
        self.clock_grid = grid;
    }

    /// Routes one raw input event through the input controller (drives the
    /// viewport + cursor/markers), returning events to push to JS.
    pub fn on_input(&mut self, ev: InputEvent, now_ms: f64) -> Vec<UiEvent> {
        let ctx = InputCtx {
            now_ms,
            rows: &self.doc.rows,
            markers: &self.doc.markers,
            selected_marker: self.doc.selected_marker,
            marker_hits: &self.last_marker_hits,
            snap_cursor: self.doc.snap_cursor,
            clock_grid: self.clock_grid,
        };
        let mut events = self.input.on_event(&ev, &mut self.viewport, &ctx);
        // Track hover locally so the next frame's geometry draws the guide.
        match ev {
            InputEvent::PointerMove { x, y, .. } => {
                let tick = crate::input::hover_tick(&self.viewport, x as f64);
                let row = crate::input::hover_row(&self.doc.rows, y as f64);
                self.hover = Some((tick, row));
            }
            InputEvent::PointerLeave => {
                self.hover = None;
                events.push(UiEvent::HoverCleared);
            }
            _ => {}
        }
        events
    }

    pub fn resize(&mut self, width_css: f32, height_css: f32, dpr: f32) {
        self.canvas = (width_css, height_css, dpr);
        self.viewport.set_width(width_css as f64);
        self.repack_pending = true;
    }

    /// Advances one frame: viewport animation → repack-window check →
    /// pack → geometry.
    pub fn frame(&mut self, now_ms: f64) -> FrameResult {
        let mut events = Vec::new();
        let tick = self.viewport.tick(now_ms);
        let animating = self.viewport.animating();

        let Some(db) = self.trace.as_mut() else {
            // No trace: still report viewport so the canvas clears cleanly.
            return FrameResult { dirty: tick.dirty, animating, ..Default::default() };
        };
        let end_ticks = db.end_ticks();

        // Repack when the window left the packed range, or a doc change forced
        // it. `needed_window` returns None while the packed window still covers.
        let mut repack = None;
        let window_moved = self.viewport.needed_window(self.packed, end_ticks);
        if self.repack_pending || window_moved.is_some() {
            let (qs, qe) = window_moved.unwrap_or_else(|| self.viewport.query_window(end_ticks));
            match self.packer.pack(db, &self.doc.rows, qs, qe) {
                Ok(out) => {
                    self.packed = Some(PackedWindow {
                        start: qs,
                        end: qe,
                        tpp: self.viewport.ticks_per_pixel(),
                    });
                    self.repack_pending = false;
                    repack = Some(out);
                }
                Err(e) => eprintln!("[engine] pack failed: {e}"),
            }
        }

        let state = self.frame_state(end_ticks);
        let geometry = build_frame_geometry(&state);
        self.last_marker_hits = geometry.marker_hits.clone();

        // Viewport-change events: every animating frame (settled flag on the
        // final tick) so JS persists the window and updates ruler readouts.
        if tick.dirty || animating || repack.is_some() {
            events.push(UiEvent::ViewportChanged {
                start: self.viewport.start_ticks(),
                end: self.viewport.view_end(),
                settled: tick.settled,
            });
        }

        let vp = self.viewport_uniform();
        FrameResult {
            dirty: true,
            animating,
            viewport: Some(vp),
            geometry: Some(geometry),
            repack,
            events,
        }
    }

    // --- internals -----------------------------------------------------------

    fn frame_state(&self, end_ticks: u64) -> FrameState {
        FrameState {
            start_ticks: self.viewport.start_ticks(),
            ticks_per_pixel: self.viewport.ticks_per_pixel(),
            width: self.canvas.0,
            height: self.canvas.1,
            wave_y_offset: RULER_HEIGHT_CSS,
            rows: self.doc.rows.clone(),
            markers: self.doc.markers.clone(),
            selected_marker: self.doc.selected_marker,
            cursor: self.doc.cursor,
            hover: self.hover,
            clock_anchor: self.doc.clock_anchor,
            clock_grid: self.clock_grid,
            end_ticks,
            metrics: self.metrics,
            bucket_bands: Vec::new(), // deferred (see module docs)
            time_decimals: self.time_decimals,
            reset_spans: Vec::new(), // deferred (see module docs)
        }
    }

    fn viewport_uniform(&self) -> ViewportUniform {
        let selected_row = self
            .doc
            .rows
            .iter()
            .find(|r| r.selected)
            .map_or(-1, |r| r.row as i32);
        ViewportUniform::new(
            self.viewport.ticks_per_pixel() as f32,
            self.viewport.start_ticks(),
            self.canvas.0,
            self.canvas.1,
            ROW_HEIGHT_CSS,
            self.canvas.2,
            selected_row,
            RULER_HEIGHT_CSS,
        )
    }

}

