//! The digital waveform pipelines (port of `gpu/digital.ts` + `digital.wgsl`):
//! one shader module, a `VARIANT` override picks single (1-bit line) vs multi
//! (pill) at pipeline build; triangle-strip rects, 4 verts × N instances;
//! 6 bind-group entries (viewport uniform + segments/colors/rows/x0/x1
//! read-only storage); alpha blending on.
//!
//! OWNED BY UNIT U6 — which also owns the migration's single semantic WGSL
//! edit: the `F_HATCH_COLOR` predicate flip in `shaders/digital.wgsl` for the
//! tide.rs X/Z plane swap (see MIGRATION.md).

use riptide_contract::gpu::PackedSegment;

use crate::colors::ColorBuffer;
use crate::device::{Gpu, ViewportBuffer};
use crate::scene::SceneBuffers;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Variant {
    Single,
    Multi,
}

/// Shader module + layouts + the two compiled pipelines, built once per
/// device/format.
#[non_exhaustive]
pub struct DigitalContext {}

/// One variant's bound draw state: segment storage buffer + bind group.
/// Rebuilt (rebind, no recompile) on every repack.
#[non_exhaustive]
pub struct SignalPipeline {
    pub segment_count: u32,
}

impl DigitalContext {
    pub fn new(_gpu: &Gpu) -> Self {
        todo!("U6: compile digital.wgsl, build bind group layout + both variant pipelines")
    }

    /// Builds the segment buffer + bind group for `segments` against the
    /// scene/viewport/colors buffers. Synchronous (pipelines pre-compiled in
    /// `new`) so add/remove repacks rebind on the spot — the old
    /// `rebindPipeline` fast path is the only path.
    pub fn bind(
        &self,
        _gpu: &Gpu,
        _variant: Variant,
        _segments: &[PackedSegment],
        _viewport: &ViewportBuffer,
        _colors: &ColorBuffer,
        _scene: &SceneBuffers,
    ) -> SignalPipeline {
        todo!("U6")
    }
}

impl SignalPipeline {
    pub fn draw(&self, _pass: &mut wgpu::RenderPass<'_>) {
        todo!("U6: setPipeline + setBindGroup + draw(4, segment_count)")
    }
}
