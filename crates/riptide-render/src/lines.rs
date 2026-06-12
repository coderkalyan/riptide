//! Instanced line batches (port of `gpu/lines.ts` + `lines.wgsl`): grid /
//! ruler notch / cursor / marker / hover lines. 16 B per instance
//! (x, color, flags, pad); flags bit0 = dashed, bit1 = full-height.
//!
//! OWNED BY UNIT U7.

use riptide_contract::geometry::LineInstance;

use crate::device::{Gpu, ViewportBuffer};

pub const MAX_LINES: usize = 1024;
const LINE_U32: usize = 4; // 16 B per line (pos + color + flags + pad)
const LINE_BYTES: usize = LINE_U32 * 4;

/// Compiled lines pipeline + the layout batches bind against. Built once per
/// device/format (mirrors `createLineRenderer`).
#[non_exhaustive]
pub struct LineRenderer {
    pub pipeline: wgpu::RenderPipeline,
    bind_group_layout: wgpu::BindGroupLayout,
    viewport_buf: wgpu::Buffer,
}

/// One instance buffer + bind group; `set_lines` rewrites only the live
/// region, `draw` issues the 4-vert triangle-strip × `line_count` instances.
#[non_exhaustive]
pub struct LineBatch {
    pub line_count: u32,
    pipeline: wgpu::RenderPipeline,
    bind_group: wgpu::BindGroup,
    instance_buf: wgpu::Buffer,
    scratch: Vec<u32>,
}

impl LineRenderer {
    pub fn new(gpu: &Gpu, viewport: &ViewportBuffer) -> Self {
        let device = &gpu.device;

        let module = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("lines"),
            source: wgpu::ShaderSource::Wgsl(crate::LINES_WGSL.into()),
        });

        let bind_group_layout =
            device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
                label: Some("lines-bgl"),
                entries: &[
                    wgpu::BindGroupLayoutEntry {
                        binding: 0,
                        visibility: wgpu::ShaderStages::VERTEX,
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
            label: Some("lines-layout"),
            bind_group_layouts: &[&bind_group_layout],
            push_constant_ranges: &[],
        });

        let pipeline = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some("lines"),
            layout: Some(&layout),
            vertex: wgpu::VertexState {
                module: &module,
                entry_point: Some("vs_line"),
                compilation_options: Default::default(),
                buffers: &[],
            },
            fragment: Some(wgpu::FragmentState {
                module: &module,
                entry_point: Some("fs_line"),
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

    pub fn create_batch(&self, gpu: &Gpu) -> LineBatch {
        let instance_buf = gpu.device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("lines-instances"),
            size: (MAX_LINES * LINE_BYTES) as u64,
            usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });

        let bind_group = gpu.device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("lines-bg"),
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

        LineBatch {
            line_count: 0,
            pipeline: self.pipeline.clone(),
            bind_group,
            instance_buf,
            scratch: vec![0u32; MAX_LINES * LINE_U32],
        }
    }
}

impl LineBatch {
    pub fn set_lines(&mut self, queue: &wgpu::Queue, lines: &[LineInstance]) {
        let count = lines.len().min(MAX_LINES);
        self.line_count = count as u32;
        if count == 0 {
            return;
        }
        for (i, l) in lines[..count].iter().enumerate() {
            let off = i * LINE_U32;
            self.scratch[off] = l.x.to_bits();
            self.scratch[off + 1] = l.color;
            self.scratch[off + 2] =
                (if l.dashed { 1 } else { 0 }) | (if l.full_height { 2 } else { 0 });
            self.scratch[off + 3] = 0;
        }
        queue.write_buffer(
            &self.instance_buf,
            0,
            bytemuck::cast_slice(&self.scratch[..count * LINE_U32]),
        );
    }

    pub fn draw(&self, pass: &mut wgpu::RenderPass<'_>) {
        if self.line_count == 0 {
            return;
        }
        pass.set_pipeline(&self.pipeline);
        pass.set_bind_group(0, &self.bind_group, &[]);
        pass.draw(0..4, 0..self.line_count);
    }
}
