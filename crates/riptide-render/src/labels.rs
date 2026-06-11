//! GPU-positioned per-segment value labels (port of `gpu/labels.ts` +
//! `labels.wgsl`): instanced glyphs positioned/culled in the shader off the
//! segment buffer + the packed label blob. Two batches per scene (multi pills,
//! single boolean text). `labels.wgsl` re-declares `RowInfo` — keep in sync
//! with the contract struct.
//!
//! OWNED BY UNIT U8.

use crate::colors::ColorBuffer;
use crate::device::{Gpu, ViewportBuffer};
use crate::scene::SceneBuffers;
use crate::text::TextRenderer;

#[non_exhaustive]
pub struct LabelRenderer {}

#[non_exhaustive]
pub struct LabelBatch {
    pub glyph_count: u32,
}

impl LabelRenderer {
    /// Shares the text renderer's atlas/sampler.
    pub fn new(_gpu: &Gpu, _text: &TextRenderer) -> Self {
        todo!("U8")
    }

    /// (Re)builds a label batch for one digital variant's segment buffer +
    /// label blob (bytes + count+1 prefix offsets). Called on every repack,
    /// with a reuse-prefix append fast path inside the unit.
    #[allow(clippy::too_many_arguments)]
    pub fn build(
        &self,
        _gpu: &Gpu,
        _viewport: &ViewportBuffer,
        _colors: &ColorBuffer,
        _scene: &SceneBuffers,
        _segment_buf: &wgpu::Buffer,
        _label_bytes: &[u8],
        _label_offsets: &[u32],
    ) -> LabelBatch {
        todo!("U8")
    }
}

impl LabelBatch {
    pub fn draw(&self, _pass: &mut wgpu::RenderPass<'_>) {
        todo!("U8")
    }
}
