//! Device handle + the shared viewport uniform buffer. (Adapter/device
//! request and surface configuration live in src-tauri — this crate never
//! sees a surface.)

use riptide_contract::gpu::{VIEWPORT_BYTES, ViewportUniform};

/// The device bundle every renderer takes. `format` is the target (surface or
/// offscreen) texture format.
pub struct Gpu {
    pub device: wgpu::Device,
    pub queue: wgpu::Queue,
    pub format: wgpu::TextureFormat,
}

/// The 48-byte frame uniform shared by all pipelines.
pub struct ViewportBuffer {
    pub buf: wgpu::Buffer,
}

impl ViewportBuffer {
    pub fn new(device: &wgpu::Device) -> Self {
        let buf = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("viewport-uniform"),
            size: VIEWPORT_BYTES as u64,
            usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });
        Self { buf }
    }

    pub fn write(&self, queue: &wgpu::Queue, vp: &ViewportUniform) {
        queue.write_buffer(&self.buf, 0, bytemuck::bytes_of(vp));
    }
}
