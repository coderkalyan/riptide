//! GPU-positioned per-segment value labels (port of `gpu/labels.ts` +
//! `labels.wgsl`): instanced glyphs positioned/culled in the shader off the
//! viewport + per-row layout. Two batches per scene (multi pills, single
//! boolean text). `labels.wgsl` re-declares `RowInfo` (7×u32) — verified in
//! sync with `riptide_contract::gpu::RowInfo`.
//!
//! Glyph instances are expanded ONCE per repack from the packed segments +
//! the native label blob (`PackOutput`: label *i* =
//! `bytes[offsets[i]..offsets[i+1]]`, `count+1` prefix offsets) — zero
//! per-frame CPU cost; the vertex shader does all positioning + culling.
//!
//! OWNED BY UNIT U8.

use riptide_contract::gpu::PackedSegment;

use crate::device::{Gpu, ViewportBuffer};
use crate::scene::SceneBuffers;
use crate::text::{ATLAS_COUNT, ATLAS_FIRST, TEXT_BLEND, TextRenderer};

/// 16 B per glyph instance: t_start, t_end, row, packed.
const LABEL_U32: usize = 4;
const LABEL_BYTES: usize = LABEL_U32 * 4;

#[non_exhaustive]
pub struct LabelRenderer {
    pipeline: wgpu::RenderPipeline,
    bgl: wgpu::BindGroupLayout,
    atlas_lg_view: wgpu::TextureView,
    sampler: wgpu::Sampler,
}

#[non_exhaustive]
pub struct LabelBatch {
    pipeline: wgpu::RenderPipeline,
    bind_group: wgpu::BindGroup,
    instance_buf: wgpu::Buffer,
    scratch: Vec<u32>,
    /// Glyph capacity of `instance_buf`/`scratch`.
    capacity_glyphs: u32,
    /// Segments already expanded into `instance_buf` — the reuse boundary
    /// for the append fast path.
    built_segs: u32,
    pub glyph_count: u32,
}

/// Expand segments `[from_seg, ..)` into `scratch` starting at glyph index
/// `from_glyph`, stopping at `cap` glyphs. Returns the new glyph count.
/// (Port of labels.ts `expand`.) Labels come straight from the native pack:
/// label *i* is the ASCII byte range `bytes[offsets[i]..offsets[i+1]]`
/// (empty for muted segments), len capped at 255 to fit the packed field.
fn expand(
    segments: &[PackedSegment],
    label_bytes: &[u8],
    label_offsets: &[u32],
    from_seg: usize,
    from_glyph: u32,
    cap: u32,
    scratch: &mut [u32],
) -> u32 {
    let mut gi = from_glyph;
    'outer: for (i, seg) in segments.iter().enumerate().skip(from_seg) {
        let start = label_offsets[i] as usize;
        let len = (label_offsets[i + 1] as usize).saturating_sub(start).min(255);
        if len == 0 {
            continue;
        }
        let row = seg.row_flags & 0xffff;
        for (k, &code) in label_bytes[start..start + len].iter().enumerate() {
            if !(0x20..=0x7e).contains(&code) {
                continue; // non-atlas — skip, keep column k
            }
            if gi >= cap {
                break 'outer; // cap to fit the storage binding
            }
            let off = gi as usize * LABEL_U32;
            scratch[off] = seg.t_start;
            scratch[off + 1] = seg.t_end;
            scratch[off + 2] = row;
            // char_code[7:0] | glyph_index(column k)[15:8] | text_len[23:16]
            scratch[off + 3] = (code as u32) | (((k as u32) & 0xff) << 8) | ((len as u32) << 16);
            gi += 1;
        }
    }
    gi
}

impl LabelRenderer {
    /// Shares the text renderer's large atlas + sampler; the pipeline's cell
    /// override constants come from its large-cell metrics.
    pub fn new(gpu: &Gpu, text: &TextRenderer) -> Self {
        let cell = text.metrics().cell_lg;

        let module = gpu.device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("labels-shader"),
            source: wgpu::ShaderSource::Wgsl(crate::LABELS_WGSL.into()),
        });

        let bgl = gpu.device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("labels-bgl"),
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
                wgpu::BindGroupLayoutEntry {
                    binding: 2,
                    visibility: wgpu::ShaderStages::VERTEX,
                    ty: wgpu::BindingType::Buffer {
                        ty: wgpu::BufferBindingType::Storage { read_only: true },
                        has_dynamic_offset: false,
                        min_binding_size: None,
                    },
                    count: None,
                },
                wgpu::BindGroupLayoutEntry {
                    binding: 3,
                    visibility: wgpu::ShaderStages::FRAGMENT,
                    ty: wgpu::BindingType::Texture {
                        sample_type: wgpu::TextureSampleType::Float { filterable: true },
                        view_dimension: wgpu::TextureViewDimension::D2,
                        multisampled: false,
                    },
                    count: None,
                },
                wgpu::BindGroupLayoutEntry {
                    binding: 4,
                    visibility: wgpu::ShaderStages::FRAGMENT,
                    ty: wgpu::BindingType::Sampler(wgpu::SamplerBindingType::Filtering),
                    count: None,
                },
            ],
        });

        let layout = gpu.device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some("labels-pipeline-layout"),
            bind_group_layouts: &[&bgl],
            push_constant_ranges: &[],
        });

        let constants = [
            ("cell_w", cell.width_px as f64),
            ("cell_h", cell.height_px as f64),
            ("midline", cell.midline_px as f64),
            ("atlas_first", ATLAS_FIRST as f64),
            ("atlas_count", ATLAS_COUNT as f64),
        ];

        let pipeline = gpu.device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some("labels-pipeline"),
            layout: Some(&layout),
            vertex: wgpu::VertexState {
                module: &module,
                entry_point: Some("vs_label"),
                compilation_options: wgpu::PipelineCompilationOptions {
                    constants: &constants,
                    ..Default::default()
                },
                buffers: &[],
            },
            fragment: Some(wgpu::FragmentState {
                module: &module,
                entry_point: Some("fs_label"),
                compilation_options: wgpu::PipelineCompilationOptions {
                    constants: &constants,
                    ..Default::default()
                },
                targets: &[Some(wgpu::ColorTargetState {
                    format: gpu.format,
                    blend: Some(TEXT_BLEND),
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
        });

        Self {
            pipeline,
            bgl,
            atlas_lg_view: text.atlas_lg_view().clone(),
            sampler: text.sampler().clone(),
        }
    }

    /// (Re)builds a label batch for one digital variant's packed segments +
    /// label blob (bytes + count+1 prefix offsets). Called on every repack.
    ///
    /// `prev` + `reuse_prefix` is the add-signal fast path (labels.ts
    /// `setLabels`'s `reusePrefix`): when `reuse_prefix` is true the caller
    /// guarantees the previously built segments are an unchanged prefix of
    /// `segments` (a pure append — rows added at the end, segments appended
    /// after the prior ones), so only the newly appended segments are
    /// expanded + uploaded and the resident GPU prefix is kept. Any change
    /// that isn't a clean append (reorder/remove/radix change/first build)
    /// must pass `reuse_prefix = false` → full rebuild. The bind group is
    /// rebuilt either way (the scene's row-info buffer changes on every
    /// scene rebuild).
    ///
    /// Note: unlike the seed stub this takes the CPU-side `segments` slice,
    /// not the GPU segment buffer — `labels.wgsl` (reused verbatim) reads
    /// per-glyph `t_start`/`t_end`/`row` baked into the instance buffer, so
    /// the instances must be expanded CPU-side exactly like labels.ts did.
    #[allow(clippy::too_many_arguments)]
    pub fn build(
        &self,
        gpu: &Gpu,
        viewport: &ViewportBuffer,
        scene: &SceneBuffers,
        segments: &[PackedSegment],
        label_bytes: &[u8],
        label_offsets: &[u32],
        prev: Option<LabelBatch>,
        reuse_prefix: bool,
    ) -> LabelBatch {
        assert_eq!(
            label_offsets.len(),
            segments.len() + 1,
            "label_offsets must hold count+1 prefix offsets"
        );

        // The instance buffer is a storage binding, so it can never exceed
        // maxStorageBufferBindingSize. Cap the glyph count to fit and warn on
        // the drop (the real fix at that scale is windowing labels to the
        // visible range — see PERFORMANCE.md "Multi-bit value labels").
        let max_glyphs =
            (gpu.device.limits().max_storage_buffer_binding_size as usize / LABEL_BYTES) as u32;

        let (mut instance_buf, mut capacity_glyphs, built_segs, prev_glyphs, mut scratch) =
            match prev {
                Some(b) => (Some(b.instance_buf), b.capacity_glyphs, b.built_segs, b.glyph_count, b.scratch),
                None => (None, 0, 0, 0, Vec::new()),
            };

        let seg_count = segments.len() as u32;
        let glyph_count;

        // Append fast path: the prefix [0, built_segs) is unchanged and
        // already resident, so expand + upload only the appended segments.
        // Needs an existing buffer, a real prefix, and room without a realloc
        // (a realloc would drop the resident prefix → full rebuild).
        let append_bytes = (label_bytes.len() as u32).saturating_sub(
            if instance_buf.is_some() && built_segs > 0 { label_offsets[built_segs as usize] } else { 0 },
        );
        let append_cap = prev_glyphs + append_bytes; // upper bound on total glyphs
        if reuse_prefix
            && instance_buf.is_some()
            && built_segs > 0
            && built_segs <= seg_count
            && append_cap <= capacity_glyphs.min(max_glyphs)
        {
            let gi = expand(
                segments,
                label_bytes,
                label_offsets,
                built_segs as usize,
                prev_glyphs,
                capacity_glyphs,
                &mut scratch,
            );
            if gi > prev_glyphs {
                gpu.queue.write_buffer(
                    instance_buf.as_ref().unwrap(),
                    prev_glyphs as u64 * LABEL_BYTES as u64,
                    bytemuck::cast_slice(&scratch[prev_glyphs as usize * LABEL_U32..gi as usize * LABEL_U32]),
                );
            }
            glyph_count = gi;
        } else {
            // Full rebuild.
            let wanted = label_bytes.len() as u32; // upper bound (skips non-atlas, caps at 255/label)
            let total = wanted.min(max_glyphs);
            if wanted > max_glyphs {
                eprintln!(
                    "[labels] glyph buffer capped at {max_glyphs} (~{} dropped): {wanted} glyphs \
                     exceeds maxStorageBufferBindingSize ({} B). Window labels to the visible \
                     range to avoid this.",
                    wanted - max_glyphs,
                    gpu.device.limits().max_storage_buffer_binding_size,
                );
            }
            let need = total.max(1);
            if instance_buf.is_none() || need > capacity_glyphs {
                capacity_glyphs = max_glyphs.min(need.max(capacity_glyphs * 2).max(256));
                instance_buf = Some(gpu.device.create_buffer(&wgpu::BufferDescriptor {
                    label: Some("labels-instances"),
                    size: capacity_glyphs as u64 * LABEL_BYTES as u64,
                    usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_DST,
                    mapped_at_creation: false,
                }));
                scratch = vec![0u32; capacity_glyphs as usize * LABEL_U32];
            }
            let gi = expand(segments, label_bytes, label_offsets, 0, 0, total, &mut scratch);
            glyph_count = gi;
            if gi > 0 {
                gpu.queue.write_buffer(
                    instance_buf.as_ref().unwrap(),
                    0,
                    bytemuck::cast_slice(&scratch[..gi as usize * LABEL_U32]),
                );
            }
        }

        let instance_buf = instance_buf.expect("instance buffer allocated above");

        // Rebind: both the instance buffer (may have been recreated) and the
        // scene's row-info buffer (new on every scene rebuild) can change.
        let bind_group = gpu.device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("labels-bindgroup"),
            layout: &self.bgl,
            entries: &[
                wgpu::BindGroupEntry { binding: 0, resource: viewport.buf.as_entire_binding() },
                wgpu::BindGroupEntry { binding: 1, resource: instance_buf.as_entire_binding() },
                wgpu::BindGroupEntry { binding: 2, resource: scene.row_info.as_entire_binding() },
                wgpu::BindGroupEntry { binding: 3, resource: wgpu::BindingResource::TextureView(&self.atlas_lg_view) },
                wgpu::BindGroupEntry { binding: 4, resource: wgpu::BindingResource::Sampler(&self.sampler) },
            ],
        });

        LabelBatch {
            pipeline: self.pipeline.clone(),
            bind_group,
            instance_buf,
            scratch,
            capacity_glyphs,
            built_segs: seg_count,
            glyph_count,
        }
    }
}

impl LabelBatch {
    pub fn draw(&self, pass: &mut wgpu::RenderPass<'_>) {
        if self.glyph_count == 0 {
            return;
        }
        pass.set_pipeline(&self.pipeline);
        pass.set_bind_group(0, &self.bind_group, &[]);
        pass.draw(0..4, 0..self.glyph_count);
    }
}
