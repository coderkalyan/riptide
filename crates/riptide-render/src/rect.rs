//! Instanced rect batches (port of `gpu/rect.ts` + `rect.wgsl`): notch/pill
//! rects, reset crosshatch, carets. 24 B per instance (x, y, w, h, color,
//! flags); flags = crosshatch|rounded|caret|caretRight|squareBL|squareBR
//! (bits 0..5, same order as rect.ts).
//!
//! OWNED BY UNIT U7. Supports ranged draws (firstInstance) for the per-pill
//! painter's-order overlays.

use riptide_contract::geometry::RectInstance;

use crate::device::{Gpu, ViewportBuffer};

pub const MAX_RECTS: usize = 1024;

#[non_exhaustive]
pub struct RectRenderer {}

#[non_exhaustive]
pub struct RectBatch {
    pub rect_count: u32,
}

impl RectRenderer {
    pub fn new(_gpu: &Gpu, _viewport: &ViewportBuffer) -> Self {
        todo!("U7")
    }

    pub fn create_batch(&self, _gpu: &Gpu) -> RectBatch {
        todo!("U7")
    }
}

impl RectBatch {
    pub fn set_rects(&mut self, _queue: &wgpu::Queue, _rects: &[RectInstance]) {
        todo!("U7")
    }

    pub fn draw(&self, _pass: &mut wgpu::RenderPass<'_>) {
        todo!("U7")
    }

    /// Draw `count` instances starting at `first` (per-pill overlay slices).
    pub fn draw_range(&self, _pass: &mut wgpu::RenderPass<'_>, _first: u32, _count: u32) {
        todo!("U7")
    }
}
