//! Glyph atlas + instanced text (port of `gpu/text.ts` + `text.wgsl`).
//! Rasterization moves from Canvas2D to `ab_glyph` with a bundled JetBrains
//! Mono Bold (the exact face the app's CSS uses for canvas text, OFL — see
//! `fonts/OFL.txt`); two atlas sizes (lg 12px / sm 10px display, weight 700,
//! matching `createTextRenderer`'s defaults) rasterized at 2×dpr for crispness
//! (geometry stays CSS px — the DPR contract). ASCII 0x20..0x7e plus the
//! middle dot (atlas slot `ATLAS_LAST+1`). 16 B per glyph instance (f32 x,
//! f32 y, u32 code|small-flag, u32 color), same packing as text.ts
//! `writeGlyph` including the middle-dot remap.
//!
//! OWNED BY UNIT U8. Exports the `TextMetrics` the geometry builder (U5)
//! consumes via the contract type.

use ab_glyph::{Font, FontRef, PxScale, ScaleFont, point};
use riptide_contract::geometry::{CellMetrics, GlyphInstance, TextMetrics};

use crate::device::{Gpu, ViewportBuffer};

pub const ATLAS_FIRST: u32 = 0x20;
pub const ATLAS_LAST: u32 = 0x7e;
pub const ATLAS_MIDDLE_DOT: u32 = 0x00b7;
/// The middle dot's atlas slot code (one past the ASCII range).
const ATLAS_EXTRA_CODE: u32 = 0x7f;
/// ASCII + the middle dot.
pub const ATLAS_COUNT: u32 = ATLAS_LAST - ATLAS_FIRST + 2;

pub const MAX_GLYPHS: usize = 4096;
const GLYPH_U32: usize = 4; // 16 B per glyph
const GLYPH_BYTES: usize = GLYPH_U32 * 4;

/// Packed into Glyph.char_code's high bit (selects the small atlas).
const SMALL_FLAG_BIT: u32 = 0x80;

/// Bundled font: JetBrains Mono Bold — the `'JetBrains Mono'` weight-700 face
/// the renderer's CSS / Canvas2D atlas used (SIL OFL 1.1, `fonts/OFL.txt`).
const FONT_BYTES: &[u8] = include_bytes!("../fonts/JetBrainsMono-Bold.ttf");

/// Display px of the two atlases — text.ts `createTextRenderer` defaults
/// (`large: 12px / 700`, `small: 10px / 700`).
const LG_DISPLAY_PX: f32 = 12.0;
const SM_DISPLAY_PX: f32 = 10.0;

/// Pack 0..255 channels little-endian to match the WGSL byte extraction
/// (port of text.ts `packRgba`).
pub fn pack_rgba(r: u8, g: u8, b: u8, a: u8) -> u32 {
    u32::from_le_bytes([r, g, b, a])
}

/// One rasterized atlas: an RGBA8 strip of `ATLAS_COUNT` cells (white RGB,
/// coverage in alpha — what `text.wgsl fs_text` samples) plus its cell
/// metrics in CSS px (the Rust `AtlasBuild`).
struct AtlasBuild {
    width: u32,
    height: u32,
    rgba: Vec<u8>,
    cell: CellMetrics,
}

/// `font_size_px` (CSS px semantics: px per em) → ab_glyph's height-based
/// `PxScale`.
fn css_px_scale(font: &FontRef<'_>, font_size_px: f32) -> PxScale {
    let upem = font.units_per_em().unwrap_or(font.height_unscaled());
    PxScale::from(font_size_px * font.height_unscaled() / upem)
}

/// Ink bounding box of `ch` positioned at the origin baseline, in px
/// (min.y is negative above the baseline). None for blank glyphs (space).
fn ink_bounds(font: &FontRef<'_>, scale: PxScale, ch: char) -> Option<ab_glyph::Rect> {
    let glyph = font.glyph_id(ch).with_scale_and_position(scale, point(0.0, 0.0));
    font.outline_glyph(glyph).map(|og| og.px_bounds())
}

/// Port of text.ts `buildAtlasCanvas`'s layout math, rasterizing with
/// ab_glyph instead of Canvas2D. All atlas-space dims are device px at
/// `2 × dpr` (bilinear handles the 2:1 downsample; AA comes from the
/// outline coverage); the returned cell metrics are CSS px.
fn build_atlas(font: &FontRef<'_>, display_px: f32, dpr: f32) -> AtlasBuild {
    let scale = 2.0 * dpr;
    let font_px = display_px * scale;
    let px_scale = css_px_scale(font, font_px);
    let scaled = font.as_scaled(px_scale);

    // Canvas2D: advance = ceil(measureText("M").width); capAscent =
    // ceil(actualBoundingBoxAscent of "M"); descent = ceil(max descent of
    // "Mgy") — same fallbacks.
    let advance = scaled.h_advance(font.glyph_id('M')).ceil();
    let cap_ascent = ink_bounds(font, px_scale, 'M')
        .map(|b| -b.min.y)
        .filter(|&a| a > 0.0)
        .unwrap_or(font_px * 0.72)
        .ceil();
    let descent = ['M', 'g', 'y']
        .into_iter()
        .filter_map(|c| ink_bounds(font, px_scale, c))
        .map(|b| b.max.y)
        .fold(0.0f32, f32::max);
    let descent = if descent > 0.0 { descent } else { font_px * 0.2 }.ceil();

    let pad_top = 2.0;
    let pad_bottom = 2.0;
    let cell_w = advance + 2.0;
    let cell_h = cap_ascent + descent + pad_top + pad_bottom;
    let baseline_y = pad_top + cap_ascent;
    let midline_y = pad_top + cap_ascent * 0.5;

    let width = (cell_w * ATLAS_COUNT as f32) as u32;
    let height = cell_h as u32;

    // White RGB everywhere, coverage in alpha — matches the Canvas atlas
    // (`fillStyle #fff` on a cleared bitmap); the shaders read only `.a`.
    let mut rgba = vec![0u8; (width * height * 4) as usize];
    for px in rgba.chunks_exact_mut(4) {
        px[0] = 0xff;
        px[1] = 0xff;
        px[2] = 0xff;
    }

    for i in 0..ATLAS_COUNT {
        let code = if i <= ATLAS_LAST - ATLAS_FIRST { ATLAS_FIRST + i } else { ATLAS_MIDDLE_DOT };
        let ch = char::from_u32(code).unwrap_or(' ');
        // Pen at cell left + 1 px, alphabetic baseline (fillText(ch, i*cellW+1, baselineY)).
        let glyph = font
            .glyph_id(ch)
            .with_scale_and_position(px_scale, point(i as f32 * cell_w + 1.0, baseline_y));
        let Some(outlined) = font.outline_glyph(glyph) else { continue };
        let bounds = outlined.px_bounds();
        outlined.draw(|x, y, c| {
            let px = bounds.min.x as i32 + x as i32;
            let py = bounds.min.y as i32 + y as i32;
            if px < 0 || py < 0 || px >= width as i32 || py >= height as i32 {
                return;
            }
            let off = ((py as u32 * width + px as u32) * 4 + 3) as usize;
            let a = (c.clamp(0.0, 1.0) * 255.0).round() as u8;
            rgba[off] = rgba[off].max(a);
        });
    }

    AtlasBuild {
        width,
        height,
        rgba,
        cell: CellMetrics {
            width_px: cell_w / scale,
            height_px: cell_h / scale,
            ascent_px: baseline_y / scale,
            midline_px: midline_y / scale,
        },
    }
}

fn upload_atlas(gpu: &Gpu, atlas: &AtlasBuild, label: &str) -> wgpu::Texture {
    let tex = gpu.device.create_texture(&wgpu::TextureDescriptor {
        label: Some(label),
        size: wgpu::Extent3d { width: atlas.width, height: atlas.height, depth_or_array_layers: 1 },
        mip_level_count: 1,
        sample_count: 1,
        dimension: wgpu::TextureDimension::D2,
        format: wgpu::TextureFormat::Rgba8Unorm,
        usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
        view_formats: &[],
    });
    gpu.queue.write_texture(
        wgpu::TexelCopyTextureInfo {
            texture: &tex,
            mip_level: 0,
            origin: wgpu::Origin3d::ZERO,
            aspect: wgpu::TextureAspect::All,
        },
        &atlas.rgba,
        wgpu::TexelCopyBufferLayout {
            offset: 0,
            bytes_per_row: Some(atlas.width * 4),
            rows_per_image: Some(atlas.height),
        },
        wgpu::Extent3d { width: atlas.width, height: atlas.height, depth_or_array_layers: 1 },
    );
    tex
}

/// src-alpha / one-minus-src-alpha color, one / one-minus-src-alpha alpha —
/// identical to text.ts (and labels.ts) pipeline blend.
pub(crate) const TEXT_BLEND: wgpu::BlendState = wgpu::BlendState {
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

#[non_exhaustive]
pub struct TextRenderer {
    pipeline: wgpu::RenderPipeline,
    bgl: wgpu::BindGroupLayout,
    viewport_buf: wgpu::Buffer,
    atlas_lg_view: wgpu::TextureView,
    atlas_sm_view: wgpu::TextureView,
    sampler: wgpu::Sampler,
    metrics: TextMetrics,
}

#[non_exhaustive]
pub struct TextBatch {
    pipeline: wgpu::RenderPipeline,
    bind_group: wgpu::BindGroup,
    instance_buf: wgpu::Buffer,
    scratch: Vec<u32>,
    pub glyph_count: u32,
}

impl TextRenderer {
    pub fn new(gpu: &Gpu, viewport: &ViewportBuffer, dpr: f32) -> Self {
        let font = FontRef::try_from_slice(FONT_BYTES).expect("bundled JetBrains Mono parses");

        let atlas_lg = build_atlas(&font, LG_DISPLAY_PX, dpr);
        let atlas_sm = build_atlas(&font, SM_DISPLAY_PX, dpr);
        let tex_lg = upload_atlas(gpu, &atlas_lg, "text-atlas-lg");
        let tex_sm = upload_atlas(gpu, &atlas_sm, "text-atlas-sm");

        let sampler = gpu.device.create_sampler(&wgpu::SamplerDescriptor {
            label: Some("text-sampler"),
            mag_filter: wgpu::FilterMode::Linear,
            min_filter: wgpu::FilterMode::Linear,
            mipmap_filter: wgpu::FilterMode::Nearest,
            ..Default::default()
        });

        let module = gpu.device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("text-shader"),
            source: wgpu::ShaderSource::Wgsl(crate::TEXT_WGSL.into()),
        });

        let bgl = gpu.device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("text-bgl"),
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
                    visibility: wgpu::ShaderStages::FRAGMENT,
                    ty: wgpu::BindingType::Texture {
                        sample_type: wgpu::TextureSampleType::Float { filterable: true },
                        view_dimension: wgpu::TextureViewDimension::D2,
                        multisampled: false,
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
            label: Some("text-pipeline-layout"),
            bind_group_layouts: &[&bgl],
            push_constant_ranges: &[],
        });

        let constants = [
            ("cell_w_lg", atlas_lg.cell.width_px as f64),
            ("cell_h_lg", atlas_lg.cell.height_px as f64),
            ("cell_w_sm", atlas_sm.cell.width_px as f64),
            ("cell_h_sm", atlas_sm.cell.height_px as f64),
            ("atlas_first", ATLAS_FIRST as f64),
            ("atlas_count", ATLAS_COUNT as f64),
        ];

        let pipeline = gpu.device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some("text-pipeline"),
            layout: Some(&layout),
            vertex: wgpu::VertexState {
                module: &module,
                entry_point: Some("vs_text"),
                compilation_options: wgpu::PipelineCompilationOptions {
                    constants: &constants,
                    ..Default::default()
                },
                buffers: &[],
            },
            fragment: Some(wgpu::FragmentState {
                module: &module,
                entry_point: Some("fs_text"),
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
            viewport_buf: viewport.buf.clone(),
            atlas_lg_view: tex_lg.create_view(&wgpu::TextureViewDescriptor::default()),
            atlas_sm_view: tex_sm.create_view(&wgpu::TextureViewDescriptor::default()),
            sampler,
            metrics: TextMetrics { cell_lg: atlas_lg.cell, cell_sm: atlas_sm.cell },
        }
    }

    /// Cell metrics of both atlas sizes (CSS px) — the geometry builder lays
    /// glyphs out with these.
    pub fn metrics(&self) -> TextMetrics {
        self.metrics
    }

    /// The large atlas view — shared with the label pipeline (labels.ts got
    /// it as `atlasLgView`).
    pub fn atlas_lg_view(&self) -> &wgpu::TextureView {
        &self.atlas_lg_view
    }

    /// The shared bilinear sampler (labels.ts `sampler`).
    pub fn sampler(&self) -> &wgpu::Sampler {
        &self.sampler
    }

    pub fn create_batch(&self, gpu: &Gpu) -> TextBatch {
        let instance_buf = gpu.device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("text-instances"),
            size: (MAX_GLYPHS * GLYPH_BYTES) as u64,
            usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });
        let bind_group = gpu.device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("text-bindgroup"),
            layout: &self.bgl,
            entries: &[
                wgpu::BindGroupEntry { binding: 0, resource: self.viewport_buf.as_entire_binding() },
                wgpu::BindGroupEntry { binding: 1, resource: instance_buf.as_entire_binding() },
                wgpu::BindGroupEntry { binding: 2, resource: wgpu::BindingResource::TextureView(&self.atlas_lg_view) },
                wgpu::BindGroupEntry { binding: 3, resource: wgpu::BindingResource::TextureView(&self.atlas_sm_view) },
                wgpu::BindGroupEntry { binding: 4, resource: wgpu::BindingResource::Sampler(&self.sampler) },
            ],
        });
        TextBatch {
            pipeline: self.pipeline.clone(),
            bind_group,
            instance_buf,
            scratch: Vec::with_capacity(MAX_GLYPHS * GLYPH_U32),
            glyph_count: 0,
        }
    }
}

impl TextBatch {
    /// Packs + uploads the glyph instances (text.ts `writeGlyph` × N +
    /// `setGlyphs`): f32 x, f32 y, u32 code|SMALL_FLAG (middle dot remapped
    /// to the extra atlas slot), u32 packed rgba. Capped at [`MAX_GLYPHS`].
    pub fn set_glyphs(&mut self, queue: &wgpu::Queue, glyphs: &[GlyphInstance]) {
        let count = glyphs.len().min(MAX_GLYPHS);
        self.glyph_count = count as u32;
        if count == 0 {
            return;
        }
        self.scratch.clear();
        for g in &glyphs[..count] {
            let atlas_code = if g.ch == ATLAS_MIDDLE_DOT { ATLAS_EXTRA_CODE } else { g.ch };
            self.scratch.push(g.x.to_bits());
            self.scratch.push(g.y.to_bits());
            self.scratch.push((atlas_code & 0x7f) | if g.small { SMALL_FLAG_BIT } else { 0 });
            self.scratch.push(g.color);
        }
        queue.write_buffer(&self.instance_buf, 0, bytemuck::cast_slice(&self.scratch));
    }

    pub fn draw(&self, pass: &mut wgpu::RenderPass<'_>) {
        self.draw_range(pass, 0, self.glyph_count);
    }

    /// Draw `count` glyphs starting at `first` (per-pill overlay slices,
    /// drawn via firstInstance like frame.ts's ranged draws).
    pub fn draw_range(&self, pass: &mut wgpu::RenderPass<'_>, first: u32, count: u32) {
        if count == 0 {
            return;
        }
        pass.set_pipeline(&self.pipeline);
        pass.set_bind_group(0, &self.bind_group, &[]);
        pass.draw(0..4, first..first + count);
    }
}
