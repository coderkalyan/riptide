//! GPU pass timing via wgpu timestamp queries (port of `gpu/timing.ts`).
//! Gracefully absent when the adapter lacks TIMESTAMP_QUERY.
//!
//! OWNED BY UNIT U12.

#[non_exhaustive]
pub struct GpuTimer {}

impl GpuTimer {
    /// None when the device lacks timestamp-query support.
    pub fn new(_device: &wgpu::Device) -> Option<Self> {
        // U12: query set + resolve/readback buffers.
        None
    }

    /// Timestamp writes to attach to the frame's render pass.
    pub fn pass_timestamp_writes(&self) -> Option<wgpu::RenderPassTimestampWrites<'_>> {
        todo!("U12")
    }

    pub fn resolve(&mut self, _encoder: &mut wgpu::CommandEncoder) {
        todo!("U12")
    }

    /// Latest completed pass duration in ms, if a readback has landed.
    pub fn read(&mut self, _device: &wgpu::Device) -> Option<f32> {
        todo!("U12")
    }
}
