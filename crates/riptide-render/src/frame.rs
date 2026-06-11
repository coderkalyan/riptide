//! The frame encoder (port of `gpu/frame.ts`): one render pass with clear,
//! painter's order — linesBg → rectsBg → digital pipelines → labels →
//! labelsSingle → textBody → linesFg → per-pill rect+text overlays (each
//! pill's own ranged draws so its rect occludes earlier pills).
//!
//! OWNED BY UNIT U12. Calls only the frozen batch APIs of U6/U7/U8.

use riptide_contract::geometry::PillRange;

use crate::device::Gpu;
use crate::digital::SignalPipeline;
use crate::labels::LabelBatch;
use crate::lines::LineBatch;
use crate::rect::RectBatch;
use crate::text::TextBatch;
use crate::timing::GpuTimer;

/// Background clear, matches `frame.ts CLEAR_VALUE`.
pub const CLEAR_VALUE: wgpu::Color = wgpu::Color { r: 0.106, g: 0.114, b: 0.129, a: 1.0 };

pub struct FrameLayers<'a> {
    pub lines_bg: &'a LineBatch,
    pub rects_bg: &'a RectBatch,
    /// Single + multi digital pipelines (0..2 live ones).
    pub digital: &'a [&'a SignalPipeline],
    pub labels: Option<&'a LabelBatch>,
    pub labels_single: Option<&'a LabelBatch>,
    pub text_body: &'a TextBatch,
    pub lines_fg: &'a LineBatch,
    pub pill_rects: &'a RectBatch,
    pub pill_text: &'a TextBatch,
    pub pill_ranges: &'a [PillRange],
}

/// Encodes + submits one frame into `view`.
pub fn render_frame(
    _gpu: &Gpu,
    _view: &wgpu::TextureView,
    _layers: &FrameLayers<'_>,
    _timer: Option<&mut GpuTimer>,
) {
    todo!("U12")
}
