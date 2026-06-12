//! Per-row color storage buffer (port of `gpu/colors.ts`): MAX_ROWS vec4<f32>
//! colors, rewritten whenever the active-signal colors change.

use riptide_contract::gpu::MAX_ROWS;

pub struct ColorBuffer {
    pub buf: wgpu::Buffer,
}

impl ColorBuffer {
    pub fn new(device: &wgpu::Device) -> Self {
        let buf = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("row-colors"),
            size: (MAX_ROWS * 16) as u64, // vec4<f32> per row
            usage: wgpu::BufferUsages::STORAGE
                | wgpu::BufferUsages::COPY_DST
                // COPY_SRC so tests/captures can read the palette back.
                | wgpu::BufferUsages::COPY_SRC,
            mapped_at_creation: false,
        });
        Self { buf }
    }

    /// Writes packed-rgba row colors (0xAABBGGRR little-endian, as everywhere
    /// else) as normalized vec4<f32>s. `colors[row]`, missing rows → 0.
    pub fn write(&self, queue: &wgpu::Queue, colors: &[u32]) {
        let mut data = [[0.0f32; 4]; MAX_ROWS];
        for (i, &c) in colors.iter().take(MAX_ROWS).enumerate() {
            let b = c.to_le_bytes();
            data[i] = [
                b[0] as f32 / 255.0,
                b[1] as f32 / 255.0,
                b[2] as f32 / 255.0,
                b[3] as f32 / 255.0,
            ];
        }
        queue.write_buffer(&self.buf, 0, bytemuck::cast_slice(&data));
    }
}
