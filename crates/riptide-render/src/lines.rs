//! Instanced line batches (port of `gpu/lines.ts` + `lines.wgsl`): grid /
//! ruler notch / cursor / marker / hover lines. 16 B per instance
//! (x, color, flags, pad); flags bit0 = dashed, bit1 = full-height.
//!
//! OWNED BY UNIT U7.

use riptide_contract::geometry::LineInstance;

use crate::device::{Gpu, ViewportBuffer};

pub const MAX_LINES: usize = 1024;

#[non_exhaustive]
pub struct LineRenderer {}

#[non_exhaustive]
pub struct LineBatch {
    pub line_count: u32,
}

impl LineRenderer {
    pub fn new(_gpu: &Gpu, _viewport: &ViewportBuffer) -> Self {
        todo!("U7")
    }

    pub fn create_batch(&self, _gpu: &Gpu) -> LineBatch {
        todo!("U7")
    }
}

impl LineBatch {
    pub fn set_lines(&mut self, _queue: &wgpu::Queue, _lines: &[LineInstance]) {
        todo!("U7")
    }

    pub fn draw(&self, _pass: &mut wgpu::RenderPass<'_>) {
        todo!("U7")
    }
}
