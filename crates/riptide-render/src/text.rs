//! Glyph atlas + instanced text (port of `gpu/text.ts` + `text.wgsl`).
//! Rasterization moves from Canvas2D to `ab_glyph` with a bundled monospace
//! font matching the app's CSS font; two atlas sizes (lg/sm) at 2×dpr for
//! crispness (geometry stays CSS px — the DPR contract). ASCII 0x20..0x7e
//! plus the middle dot. 16 B per glyph instance (x, y, code|small-flag,
//! color), same packing as text.ts writeGlyph.
//!
//! OWNED BY UNIT U8. Exports the `TextMetrics` the geometry builder (U5)
//! consumes via the contract type.

use riptide_contract::geometry::{GlyphInstance, TextMetrics};

use crate::device::{Gpu, ViewportBuffer};

pub const MAX_GLYPHS: usize = 4096;

#[non_exhaustive]
pub struct TextRenderer {}

#[non_exhaustive]
pub struct TextBatch {
    pub glyph_count: u32,
}

impl TextRenderer {
    pub fn new(_gpu: &Gpu, _viewport: &ViewportBuffer, _dpr: f32) -> Self {
        todo!("U8: rasterize both atlases, build pipeline + sampler")
    }

    /// Cell metrics of both atlas sizes (CSS px) — the geometry builder lays
    /// glyphs out with these.
    pub fn metrics(&self) -> TextMetrics {
        todo!("U8")
    }

    pub fn create_batch(&self, _gpu: &Gpu) -> TextBatch {
        todo!("U8")
    }
}

impl TextBatch {
    pub fn set_glyphs(&mut self, _queue: &wgpu::Queue, _glyphs: &[GlyphInstance]) {
        todo!("U8")
    }

    pub fn draw(&self, _pass: &mut wgpu::RenderPass<'_>) {
        todo!("U8")
    }

    /// Draw `count` glyphs starting at `first` (per-pill overlay slices).
    pub fn draw_range(&self, _pass: &mut wgpu::RenderPass<'_>, _first: u32, _count: u32) {
        todo!("U8")
    }
}
