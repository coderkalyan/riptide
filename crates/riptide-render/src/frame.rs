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

// The drawX helpers of frame.ts: skip empty batches.
fn draw_lines(pass: &mut wgpu::RenderPass<'_>, b: &LineBatch) {
    if b.line_count > 0 {
        b.draw(pass);
    }
}
fn draw_rects(pass: &mut wgpu::RenderPass<'_>, b: &RectBatch) {
    if b.rect_count > 0 {
        b.draw(pass);
    }
}
fn draw_text(pass: &mut wgpu::RenderPass<'_>, b: &TextBatch) {
    if b.glyph_count > 0 {
        b.draw(pass);
    }
}
fn draw_labels(pass: &mut wgpu::RenderPass<'_>, b: Option<&LabelBatch>) {
    if let Some(b) = b
        && b.glyph_count > 0
    {
        b.draw(pass);
    }
}

/// Encodes + submits one frame into `view`.
pub fn render_frame(
    gpu: &Gpu,
    view: &wgpu::TextureView,
    layers: &FrameLayers<'_>,
    mut timer: Option<&mut GpuTimer>,
) {
    let mut enc = gpu
        .device
        .create_command_encoder(&wgpu::CommandEncoderDescriptor { label: Some("frame") });
    {
        let mut pass = enc.begin_render_pass(&wgpu::RenderPassDescriptor {
            label: Some("frame-pass"),
            color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                view,
                depth_slice: None,
                resolve_target: None,
                ops: wgpu::Operations {
                    load: wgpu::LoadOp::Clear(CLEAR_VALUE),
                    store: wgpu::StoreOp::Store,
                },
            })],
            depth_stencil_attachment: None,
            timestamp_writes: timer.as_deref().and_then(GpuTimer::pass_timestamp_writes),
            occlusion_query_set: None,
        });

        draw_lines(&mut pass, layers.lines_bg);
        draw_rects(&mut pass, layers.rects_bg);

        for pipeline in layers.digital {
            pipeline.draw(&mut pass);
        }

        // Value labels sit inside the multi-bit pills → draw after the digital
        // pipelines; then the boolean true/false labels over the 1-bit lines.
        draw_labels(&mut pass, layers.labels);
        draw_labels(&mut pass, layers.labels_single);

        draw_text(&mut pass, layers.text_body);
        draw_lines(&mut pass, layers.lines_fg);

        // Pill overlays draw last — opaque, on top of everything else. One
        // ranged draw per pill (rect then text) into the shared buffers, so
        // each pill's rect fully occludes earlier pills on overlap.
        for pr in layers.pill_ranges {
            if pr.rect_count > 0 {
                layers.pill_rects.draw_range(&mut pass, pr.rect_start, pr.rect_count);
            }
            if pr.text_count > 0 {
                layers.pill_text.draw_range(&mut pass, pr.text_start, pr.text_count);
            }
        }
    }

    if let Some(t) = timer.as_deref_mut() {
        t.resolve(&mut enc);
    }
    gpu.queue.submit([enc.finish()]);
    if let Some(t) = timer {
        t.readback();
    }
}
