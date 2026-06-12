//! The engine: one struct owning trace + packer + viewport + doc mirror, with
//! the methods the Tauri command layer (U10) calls. Bodies are wired for real
//! at INTEGRATION (U15), after the parallel units land — U10 must treat these
//! as opaque (call them, don't test through them).
//!
//! Seed stubs are non-panicking (empty defaults) so command plumbing can be
//! unit-tested before integration.

use riptide_contract::doc::DocSync;
use riptide_contract::geometry::FrameGeometry;
use riptide_contract::gpu::ViewportUniform;
use riptide_contract::ipc::{InputEvent, TraceSummary, UiEvent};
use riptide_contract::pack::PackOutput;

use crate::pack::Packer;
use crate::viewport::Viewport;
use crate::{Error, TraceDb};

#[derive(Default)]
pub struct Engine {
    pub trace: Option<TraceDb>,
    pub packer: Packer,
    pub viewport: Viewport,
    pub doc: DocSync,
    /// CSS-px canvas size + device pixel ratio (set via `resize`).
    pub canvas: (f32, f32, f32),
}

/// One frame's outputs for the render loop.
#[derive(Default)]
pub struct FrameResult {
    /// Anything changed — encode + present this frame.
    pub dirty: bool,
    pub viewport: Option<ViewportUniform>,
    pub geometry: Option<FrameGeometry>,
    /// A repack happened — rebuild segment/scene buffers.
    pub repack: Option<PackOutput>,
    pub events: Vec<UiEvent>,
}

impl Engine {
    pub fn new() -> Self {
        Self::default()
    }

    /// Opens a trace, clears the pack cache, resets the viewport. Implemented
    /// by U10 (it is plain delegation to `TraceDb::open` + resets).
    pub fn load_trace(&mut self, path: &str) -> Result<TraceSummary, Error> {
        let db = TraceDb::open(path)?;
        let summary = TraceSummary {
            path: path.to_string(),
            end_ticks: db.end_ticks() as f64,
            timescale: db.timescale().map(crate::trace::timescale_dto),
            diagnostics: db.diagnostics(),
        };
        self.packer.clear();
        self.trace = Some(db);
        Ok(summary)
    }

    /// Applies a JS document sync (diffing rows against the pack cache).
    /// Returns events to push (e.g. ClockGridChanged). Wired at U15.
    pub fn sync_doc(&mut self, doc: DocSync) -> Vec<UiEvent> {
        if doc.generation < self.doc.generation {
            return Vec::new(); // stale sync raced a canvas-originated change
        }
        self.doc = doc;
        Vec::new()
    }

    /// Routes one raw input event. Returns events to push. Wired at U15.
    pub fn on_input(&mut self, _ev: InputEvent) -> Vec<UiEvent> {
        Vec::new()
    }

    pub fn resize(&mut self, width_css: f32, height_css: f32, dpr: f32) {
        self.canvas = (width_css, height_css, dpr);
    }

    /// Advances one frame: viewport animation → repack-window check →
    /// pack/buckets → geometry. Wired at U15.
    pub fn frame(&mut self, _now_ms: f64) -> FrameResult {
        FrameResult::default()
    }
}
