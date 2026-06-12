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
/// device/format. Both variants are compiled eagerly in [`DigitalContext::new`]
/// so [`DigitalContext::bind`] is synchronous (the old `rebindPipeline` fast
/// path is the only path).
#[non_exhaustive]
pub struct DigitalContext {
    pub module: wgpu::ShaderModule,
    pub bgl: wgpu::BindGroupLayout,
    pub layout: wgpu::PipelineLayout,
    single: wgpu::RenderPipeline,
    multi: wgpu::RenderPipeline,
}

/// One variant's bound draw state: segment storage buffer + bind group.
/// Rebuilt (rebind, no recompile) on every repack.
#[non_exhaustive]
pub struct SignalPipeline {
    pipeline: wgpu::RenderPipeline,
    bind_group: wgpu::BindGroup,
    /// The per-variant segment storage buffer backing this pipeline's bind
    /// group (the label batches bind it too).
    pub segment_buf: wgpu::Buffer,
    pub segment_count: u32,
}

/// Alpha blend state from `digital.ts`: straight src-alpha over for color,
/// (one, one-minus-src-alpha) for alpha.
const BLEND: wgpu::BlendState = wgpu::BlendState {
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
};

fn build_pipeline(
    gpu: &Gpu,
    module: &wgpu::ShaderModule,
    layout: &wgpu::PipelineLayout,
    variant: Variant,
) -> wgpu::RenderPipeline {
    let (label, fs_entry, variant_const) = match variant {
        Variant::Single => ("digital-single", "fs_single", 0.0),
        Variant::Multi => ("digital-multi", "fs_multi", 1.0),
    };
    let constants: &[(&str, f64)] = &[("VARIANT", variant_const)];
    gpu.device
        .create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some(label),
            layout: Some(layout),
            vertex: wgpu::VertexState {
                module,
                entry_point: Some("vs_main"),
                compilation_options: wgpu::PipelineCompilationOptions {
                    constants,
                    ..Default::default()
                },
                buffers: &[],
            },
            fragment: Some(wgpu::FragmentState {
                module,
                entry_point: Some(fs_entry),
                compilation_options: wgpu::PipelineCompilationOptions {
                    constants,
                    ..Default::default()
                },
                targets: &[Some(wgpu::ColorTargetState {
                    format: gpu.format,
                    blend: Some(BLEND),
                    write_mask: wgpu::ColorWrites::ALL,
                })],
            }),
            primitive: wgpu::PrimitiveState {
                topology: wgpu::PrimitiveTopology::TriangleStrip,
                ..Default::default()
            },
            depth_stencil: None,
            multisample: wgpu::MultisampleState::default(),
            multiview: None,
            cache: None,
        })
}

impl DigitalContext {
    pub fn new(gpu: &Gpu) -> Self {
        let module = gpu
            .device
            .create_shader_module(wgpu::ShaderModuleDescriptor {
                label: Some("digital-wgsl"),
                source: wgpu::ShaderSource::Wgsl(crate::DIGITAL_WGSL.into()),
            });

        // 6 bindings: viewport uniform (vs+fs) + segments/colors/rows/x0/x1
        // read-only storage (vs only) — mirrors digital.ts's bind group layout.
        let storage_entry = |binding: u32| wgpu::BindGroupLayoutEntry {
            binding,
            visibility: wgpu::ShaderStages::VERTEX,
            ty: wgpu::BindingType::Buffer {
                ty: wgpu::BufferBindingType::Storage { read_only: true },
                has_dynamic_offset: false,
                min_binding_size: None,
            },
            count: None,
        };
        let bgl = gpu
            .device
            .create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
                label: Some("digital-bgl"),
                entries: &[
                    wgpu::BindGroupLayoutEntry {
                        binding: 0,
                        visibility: wgpu::ShaderStages::VERTEX | wgpu::ShaderStages::FRAGMENT,
                        ty: wgpu::BindingType::Buffer {
                            ty: wgpu::BufferBindingType::Uniform,
                            has_dynamic_offset: false,
                            min_binding_size: None,
                        },
                        count: None,
                    },
                    storage_entry(1),
                    storage_entry(2),
                    storage_entry(3),
                    storage_entry(4),
                    storage_entry(5),
                ],
            });

        let layout = gpu
            .device
            .create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
                label: Some("digital-layout"),
                bind_group_layouts: &[&bgl],
                push_constant_ranges: &[],
            });

        let single = build_pipeline(gpu, &module, &layout, Variant::Single);
        let multi = build_pipeline(gpu, &module, &layout, Variant::Multi);

        Self {
            module,
            bgl,
            layout,
            single,
            multi,
        }
    }

    /// Builds the segment buffer + bind group for `segments` against the
    /// scene/viewport/colors buffers. Synchronous (pipelines pre-compiled in
    /// `new`) so add/remove repacks rebind on the spot — the old
    /// `rebindPipeline` fast path is the only path.
    pub fn bind(
        &self,
        gpu: &Gpu,
        variant: Variant,
        segments: &[PackedSegment],
        viewport: &ViewportBuffer,
        colors: &ColorBuffer,
        scene: &SceneBuffers,
    ) -> SignalPipeline {
        let bytes: &[u8] = bytemuck::cast_slice(segments);
        // An empty scene still validates: WebGPU/wgpu checks each binding
        // against the pipeline's required size even for a 0-instance draw, so
        // pad the (possibly empty) segment buffer to at least one stride
        // (Segment = 12 B; 16 keeps the digital.ts minimum).
        let size = (bytes.len() as u64).max(16);
        let segment_buf = gpu.device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("digital-segments"),
            size,
            usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });
        if !bytes.is_empty() {
            gpu.queue.write_buffer(&segment_buf, 0, bytes);
        }

        let bind_group = gpu.device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("digital-bindgroup"),
            layout: &self.bgl,
            entries: &[
                wgpu::BindGroupEntry {
                    binding: 0,
                    resource: viewport.buf.as_entire_binding(),
                },
                wgpu::BindGroupEntry {
                    binding: 1,
                    resource: segment_buf.as_entire_binding(),
                },
                wgpu::BindGroupEntry {
                    binding: 2,
                    resource: colors.buf.as_entire_binding(),
                },
                wgpu::BindGroupEntry {
                    binding: 3,
                    resource: scene.row_info.as_entire_binding(),
                },
                wgpu::BindGroupEntry {
                    binding: 4,
                    resource: scene.x0_pool.as_entire_binding(),
                },
                wgpu::BindGroupEntry {
                    binding: 5,
                    resource: scene.x1_pool.as_entire_binding(),
                },
            ],
        });

        let pipeline = match variant {
            Variant::Single => self.single.clone(),
            Variant::Multi => self.multi.clone(),
        };

        SignalPipeline {
            pipeline,
            bind_group,
            segment_buf,
            segment_count: segments.len() as u32,
        }
    }
}

impl SignalPipeline {
    pub fn draw(&self, pass: &mut wgpu::RenderPass<'_>) {
        pass.set_pipeline(&self.pipeline);
        pass.set_bind_group(0, &self.bind_group, &[]);
        pass.draw(0..4, 0..self.segment_count);
    }
}
