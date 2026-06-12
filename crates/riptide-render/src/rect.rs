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
const RECT_U32: usize = 6; // 24 B per rect: x, y, w, h, color, flags
const RECT_BYTES: usize = RECT_U32 * 4;

/// Compiled rect pipeline + the layout batches bind against. Built once per
/// device/format (mirrors `createRectRenderer`).
#[non_exhaustive]
pub struct RectRenderer {
    pub pipeline: wgpu::RenderPipeline,
    bind_group_layout: wgpu::BindGroupLayout,
    viewport_buf: wgpu::Buffer,
}

/// One instance buffer + bind group; `set_rects` rewrites only the live
/// region, `draw` issues the 4-vert triangle-strip × `rect_count` instances.
#[non_exhaustive]
pub struct RectBatch {
    pub rect_count: u32,
    pipeline: wgpu::RenderPipeline,
    bind_group: wgpu::BindGroup,
    instance_buf: wgpu::Buffer,
    scratch: Vec<u32>,
}

impl RectRenderer {
    pub fn new(gpu: &Gpu, viewport: &ViewportBuffer) -> Self {
        let device = &gpu.device;

        let module = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("rect"),
            source: wgpu::ShaderSource::Wgsl(crate::RECT_WGSL.into()),
        });

        let bind_group_layout =
            device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
                label: Some("rect-bgl"),
                entries: &[
                    wgpu::BindGroupLayoutEntry {
                        binding: 0,
                        // rect.ts exposes the viewport uniform to VERTEX |
                        // FRAGMENT (unlike lines.ts) — copied exactly.
                        visibility: wgpu::ShaderStages::VERTEX | wgpu::ShaderStages::FRAGMENT,
                        ty: wgpu::BindingType::Buffer {
                            ty: wgpu::BufferBindingType::Uniform,
                            has_dynamic_offset: false,
                            min_binding_size: None,
                        },
                        count: None,
                    },
                    wgpu::BindGroupLayoutEntry {
                        binding: 1,
                        visibility: wgpu::ShaderStages::VERTEX,
                        ty: wgpu::BindingType::Buffer {
                            ty: wgpu::BufferBindingType::Storage { read_only: true },
                            has_dynamic_offset: false,
                            min_binding_size: None,
                        },
                        count: None,
                    },
                ],
            });

        let layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some("rect-layout"),
            bind_group_layouts: &[&bind_group_layout],
            push_constant_ranges: &[],
        });

        let pipeline = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some("rect"),
            layout: Some(&layout),
            vertex: wgpu::VertexState {
                module: &module,
                entry_point: Some("vs_rect"),
                compilation_options: Default::default(),
                buffers: &[],
            },
            fragment: Some(wgpu::FragmentState {
                module: &module,
                entry_point: Some("fs_rect"),
                compilation_options: Default::default(),
                targets: &[Some(wgpu::ColorTargetState {
                    format: gpu.format,
                    blend: Some(wgpu::BlendState {
                        color: wgpu::BlendComponent {
                            src_factor: wgpu::BlendFactor::SrcAlpha,
                            dst_factor: wgpu::BlendFactor::OneMinusSrcAlpha,
                            operation: wgpu::BlendOperation::Add,
                        },
                        alpha: wgpu::BlendComponent {
                            src_factor: wgpu::BlendFactor::One,
                            dst_factor: wgpu::BlendFactor::OneMinusSrcAlpha,
                            operation: wgpu::BlendOperation::Add,
                        },
                    }),
                    write_mask: wgpu::ColorWrites::ALL,
                })],
            }),
            primitive: wgpu::PrimitiveState {
                topology: wgpu::PrimitiveTopology::TriangleStrip,
                ..Default::default()
            },
            depth_stencil: None,
            multisample: Default::default(),
            multiview: None,
            cache: None,
        });

        Self {
            pipeline,
            bind_group_layout,
            viewport_buf: viewport.buf.clone(),
        }
    }

    pub fn create_batch(&self, gpu: &Gpu) -> RectBatch {
        let instance_buf = gpu.device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("rect-instances"),
            size: (MAX_RECTS * RECT_BYTES) as u64,
            usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });

        let bind_group = gpu.device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("rect-bg"),
            layout: &self.bind_group_layout,
            entries: &[
                wgpu::BindGroupEntry {
                    binding: 0,
                    resource: self.viewport_buf.as_entire_binding(),
                },
                wgpu::BindGroupEntry {
                    binding: 1,
                    resource: instance_buf.as_entire_binding(),
                },
            ],
        });

        RectBatch {
            rect_count: 0,
            pipeline: self.pipeline.clone(),
            bind_group,
            instance_buf,
            scratch: vec![0u32; MAX_RECTS * RECT_U32],
        }
    }
}

impl RectBatch {
    pub fn set_rects(&mut self, queue: &wgpu::Queue, rects: &[RectInstance]) {
        let count = rects.len().min(MAX_RECTS);
        self.rect_count = count as u32;
        if count == 0 {
            return;
        }
        for (i, r) in rects[..count].iter().enumerate() {
            let off = i * RECT_U32;
            self.scratch[off] = r.x.to_bits();
            self.scratch[off + 1] = r.y.to_bits();
            self.scratch[off + 2] = r.w.to_bits();
            self.scratch[off + 3] = r.h.to_bits();
            self.scratch[off + 4] = r.color;
            self.scratch[off + 5] = (if r.crosshatch { 1 } else { 0 })
                | (if r.rounded { 2 } else { 0 })
                | (if r.caret { 4 } else { 0 })
                | (if r.caret_right { 8 } else { 0 })
                | (if r.square_bottom_left { 16 } else { 0 })
                | (if r.square_bottom_right { 32 } else { 0 });
        }
        queue.write_buffer(
            &self.instance_buf,
            0,
            bytemuck::cast_slice(&self.scratch[..count * RECT_U32]),
        );
    }

    pub fn draw(&self, pass: &mut wgpu::RenderPass<'_>) {
        if self.rect_count == 0 {
            return;
        }
        pass.set_pipeline(&self.pipeline);
        pass.set_bind_group(0, &self.bind_group, &[]);
        pass.draw(0..4, 0..self.rect_count);
    }

    /// Draw `count` instances starting at `first` (per-pill overlay slices).
    /// Mirrors `frame.ts`'s `pass.draw(4, count, 0, first)` — `instance_index`
    /// in the shader includes the first-instance offset.
    pub fn draw_range(&self, pass: &mut wgpu::RenderPass<'_>, first: u32, count: u32) {
        if count == 0 {
            return;
        }
        pass.set_pipeline(&self.pipeline);
        pass.set_bind_group(0, &self.bind_group, &[]);
        pass.draw(0..4, first..first + count);
    }
}
