//! Shared per-scene buffers (row infos + sample pools) consumed by the
//! digital and label pipelines. Port of `gpu/digital.ts createSceneBuffers` /
//! `setRowFlags` / `setRowLayout` — including the live patching of the
//! flags/y/height words without a repack.

use riptide_contract::gpu::{ROW_FLAG_DIM, ROW_FLAG_HIGHLIGHT, ROW_INFO_WORDS, RowInfo};

pub struct SceneBuffers {
    pub row_info: wgpu::Buffer,
    pub x0_pool: wgpu::Buffer,
    pub x1_pool: wgpu::Buffer,
    /// CPU copy of the row-info words, retained so flag/layout patches can
    /// rewrite the buffer without a repack.
    row_info_cpu: Vec<u32>,
}

const ROW_WORD_FLAGS: usize = 4;
const ROW_WORD_Y: usize = 5;
const ROW_WORD_H: usize = 6;

fn storage(device: &wgpu::Device, label: &str, bytes: &[u8], min_size: u64) -> wgpu::Buffer {
    let size = (bytes.len() as u64).max(min_size);
    device.create_buffer(&wgpu::BufferDescriptor {
        label: Some(label),
        size,
        usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_DST,
        mapped_at_creation: false,
    })
}

impl SceneBuffers {
    /// `x0`/`x1` must already be padded to 4-byte multiples (the pack layer's
    /// finalize guarantees this).
    pub fn new(
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        row_infos: &[RowInfo],
        x0: &[u8],
        x1: &[u8],
    ) -> Self {
        debug_assert_eq!(x0.len() % 4, 0);
        debug_assert_eq!(x1.len() % 4, 0);
        let row_bytes: &[u8] = bytemuck::cast_slice(row_infos);
        // Empty scene: bindings still validate against one array stride.
        let row_info = storage(device, "scene-rowinfo", row_bytes, (ROW_INFO_WORDS * 4) as u64);
        let x0_pool = storage(device, "scene-x0", x0, 16);
        let x1_pool = storage(device, "scene-x1", x1, 16);
        if !row_bytes.is_empty() {
            queue.write_buffer(&row_info, 0, row_bytes);
        }
        if !x0.is_empty() {
            queue.write_buffer(&x0_pool, 0, x0);
        }
        if !x1.is_empty() {
            queue.write_buffer(&x1_pool, 0, x1);
        }
        Self {
            row_info,
            x0_pool,
            x1_pool,
            row_info_cpu: bytemuck::cast_slice(row_infos).to_vec(),
        }
    }

    pub fn row_count(&self) -> usize {
        self.row_info_cpu.len() / ROW_INFO_WORDS
    }

    /// Patches the per-row dim/highlight flags column and re-uploads (one
    /// small write, no repack).
    pub fn set_row_flags(&mut self, queue: &wgpu::Queue, hidden: &[bool], selected: &[bool]) {
        let rows = self.row_count();
        for r in 0..rows {
            let mut f = 0u32;
            if hidden.get(r).copied().unwrap_or(false) {
                f |= ROW_FLAG_DIM;
            }
            if selected.get(r).copied().unwrap_or(false) {
                f |= ROW_FLAG_HIGHLIGHT;
            }
            self.row_info_cpu[r * ROW_INFO_WORDS + ROW_WORD_FLAGS] = f;
        }
        self.upload(queue);
    }

    /// Writes the per-row vertical layout (CSS px as f32 bits): `layout[row] =
    /// (y_offset, height)`.
    pub fn set_row_layout(&mut self, queue: &wgpu::Queue, layout: &[(f32, f32)]) {
        let rows = self.row_count();
        for (r, &(y, h)) in layout.iter().take(rows).enumerate() {
            self.row_info_cpu[r * ROW_INFO_WORDS + ROW_WORD_Y] = y.to_bits();
            self.row_info_cpu[r * ROW_INFO_WORDS + ROW_WORD_H] = h.to_bits();
        }
        self.upload(queue);
    }

    fn upload(&self, queue: &wgpu::Queue) {
        if !self.row_info_cpu.is_empty() {
            queue.write_buffer(&self.row_info, 0, bytemuck::cast_slice(&self.row_info_cpu));
        }
    }
}
