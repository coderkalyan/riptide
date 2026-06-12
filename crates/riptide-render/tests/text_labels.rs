//! Headless render tests for the text + label pipelines (unit U8). Each test
//! skips with a warning when no wgpu adapter is available.

use riptide_contract::geometry::GlyphInstance;
use riptide_contract::gpu::{PackedSegment, RowInfo, ViewportUniform};
use riptide_render::device::{Gpu, ViewportBuffer};
use riptide_render::labels::LabelRenderer;
use riptide_render::scene::SceneBuffers;
use riptide_render::text::{TextRenderer, pack_rgba};

const W: u32 = 256;
const H: u32 = 64;

fn gpu() -> Option<Gpu> {
    let instance = wgpu::Instance::default();
    let adapter = pollster::block_on(instance.request_adapter(&wgpu::RequestAdapterOptions {
        power_preference: wgpu::PowerPreference::None,
        force_fallback_adapter: false,
        compatible_surface: None,
    }))
    .ok()?;
    let (device, queue) =
        pollster::block_on(adapter.request_device(&wgpu::DeviceDescriptor::default())).ok()?;
    Some(Gpu { device, queue, format: wgpu::TextureFormat::Rgba8Unorm })
}

macro_rules! gpu_or_skip {
    () => {
        match gpu() {
            Some(g) => g,
            None => {
                eprintln!("WARNING: no wgpu adapter available — skipping test");
                return;
            }
        }
    };
}

/// Standard test viewport: 1 tick = 1 CSS px, start at 0, dpr 1 (CSS px ==
/// device px on the W×H target).
fn write_viewport(gpu: &Gpu, vp: &ViewportBuffer) {
    let u = ViewportUniform::new(1.0, 0.0, W as f32, H as f32, 20.0, 1.0, -1, 0.0);
    vp.write(&gpu.queue, &u);
}

/// Renders `draw` into a cleared (black) W×H rgba8 target and reads it back
/// as tightly-packed RGBA bytes. W×4 = 1024 B per row — already 256-aligned.
fn render_and_read(gpu: &Gpu, draw: &mut dyn FnMut(&mut wgpu::RenderPass<'_>)) -> Vec<u8> {
    let tex = gpu.device.create_texture(&wgpu::TextureDescriptor {
        label: Some("test-target"),
        size: wgpu::Extent3d { width: W, height: H, depth_or_array_layers: 1 },
        mip_level_count: 1,
        sample_count: 1,
        dimension: wgpu::TextureDimension::D2,
        format: wgpu::TextureFormat::Rgba8Unorm,
        usage: wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::COPY_SRC,
        view_formats: &[],
    });
    let view = tex.create_view(&wgpu::TextureViewDescriptor::default());

    let readback = gpu.device.create_buffer(&wgpu::BufferDescriptor {
        label: Some("test-readback"),
        size: (W * H * 4) as u64,
        usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
        mapped_at_creation: false,
    });

    let mut encoder = gpu.device.create_command_encoder(&wgpu::CommandEncoderDescriptor::default());
    {
        let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
            label: Some("test-pass"),
            color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                view: &view,
                depth_slice: None,
                resolve_target: None,
                ops: wgpu::Operations {
                    load: wgpu::LoadOp::Clear(wgpu::Color::BLACK),
                    store: wgpu::StoreOp::Store,
                },
            })],
            depth_stencil_attachment: None,
            timestamp_writes: None,
            occlusion_query_set: None,
        });
        draw(&mut pass);
    }
    encoder.copy_texture_to_buffer(
        wgpu::TexelCopyTextureInfo {
            texture: &tex,
            mip_level: 0,
            origin: wgpu::Origin3d::ZERO,
            aspect: wgpu::TextureAspect::All,
        },
        wgpu::TexelCopyBufferInfo {
            buffer: &readback,
            layout: wgpu::TexelCopyBufferLayout {
                offset: 0,
                bytes_per_row: Some(W * 4),
                rows_per_image: None,
            },
        },
        wgpu::Extent3d { width: W, height: H, depth_or_array_layers: 1 },
    );
    gpu.queue.submit([encoder.finish()]);

    let slice = readback.slice(..);
    let (tx, rx) = std::sync::mpsc::channel();
    slice.map_async(wgpu::MapMode::Read, move |r| tx.send(r).unwrap());
    gpu.device.poll(wgpu::PollType::wait_indefinitely()).unwrap();
    rx.recv().unwrap().unwrap();
    let data = slice.get_mapped_range().to_vec();
    readback.unmap();
    data
}

/// Count non-background ("ink") pixels in the half-open box. Background is
/// black; white-on-black blended text leaves r == coverage.
fn ink_pixels(data: &[u8], x0: u32, x1: u32, y0: u32, y1: u32) -> usize {
    let mut n = 0;
    for y in y0..y1.min(H) {
        for x in x0..x1.min(W) {
            if data[((y * W + x) * 4) as usize] > 40 {
                n += 1;
            }
        }
    }
    n
}

#[test]
fn metrics_snapshot() {
    let gpu = gpu_or_skip!();
    let vp = ViewportBuffer::new(&gpu.device);
    let text = TextRenderer::new(&gpu, &vp, 1.0);
    let m = text.metrics();

    for (name, c) in [("lg", m.cell_lg), ("sm", m.cell_sm)] {
        assert!(c.width_px > 0.0, "{name} width > 0");
        assert!(c.height_px > c.width_px, "{name} mono cell taller than wide");
        assert!(c.ascent_px > 0.0 && c.ascent_px <= c.height_px, "{name} ascent within cell");
        assert!(c.midline_px > 0.0 && c.midline_px < c.ascent_px, "{name} midline above baseline");
        // padTop = 2 atlas px = 1 CSS px at dpr 1; midline = padTop + capAscent/2.
        let pad_top = 1.0;
        let cap = c.ascent_px - pad_top;
        assert!(
            (c.midline_px - (pad_top + cap * 0.5)).abs() < 1e-3,
            "{name} midline = padTop + capAscent/2"
        );
    }

    // JetBrains Mono advance is 0.6 em: lg cell = ceil(0.6*24)+2 = 17 atlas px
    // = 8.5 CSS px at dpr 1; sm = ceil(0.6*20)+2 = 14 → 7.0.
    assert!((m.cell_lg.width_px - 8.5).abs() < 0.51, "lg cell width ≈ 8.5, got {}", m.cell_lg.width_px);
    assert!((m.cell_sm.width_px - 7.0).abs() < 0.51, "sm cell width ≈ 7.0, got {}", m.cell_sm.width_px);
    assert!(m.cell_sm.width_px < m.cell_lg.width_px);
    assert!(m.cell_sm.height_px < m.cell_lg.height_px);
}

#[test]
fn text_batch_renders_0xab() {
    let gpu = gpu_or_skip!();
    let vp = ViewportBuffer::new(&gpu.device);
    write_viewport(&gpu, &vp);
    let text = TextRenderer::new(&gpu, &vp, 1.0);
    let cell = text.metrics().cell_lg;

    let white = pack_rgba(255, 255, 255, 255);
    let (x0, y0) = (10.0f32, 10.0f32);
    let glyphs: Vec<GlyphInstance> = "0xAB"
        .bytes()
        .enumerate()
        .map(|(i, b)| GlyphInstance {
            x: x0 + i as f32 * cell.width_px,
            y: y0,
            ch: b as u32,
            color: white,
            small: false,
        })
        .collect();

    let mut batch = text.create_batch(&gpu);
    batch.set_glyphs(&gpu.queue, &glyphs);
    assert_eq!(batch.glyph_count, 4);

    let data = render_and_read(&gpu, &mut |pass| batch.draw(pass));

    // Glyph-shaped coverage inside the text box…
    let bx1 = (x0 + 4.0 * cell.width_px).ceil() as u32 + 1;
    let by1 = (y0 + cell.height_px).ceil() as u32 + 1;
    let inside = ink_pixels(&data, x0 as u32, bx1, y0 as u32, by1);
    let box_area = ((bx1 - x0 as u32) * (by1 - y0 as u32)) as usize;
    assert!(inside > 30, "expected glyph ink inside the text box, got {inside}");
    assert!(inside < box_area * 3 / 4, "ink should be glyph-shaped, not a filled box");
    // …and (almost) none outside it.
    let outside = ink_pixels(&data, 0, W, 0, H) - inside;
    assert!(outside <= 4, "ink outside the text box: {outside}");
}

#[test]
fn lg_vs_sm_flag_picks_different_cell_sizes() {
    let gpu = gpu_or_skip!();
    let vp = ViewportBuffer::new(&gpu.device);
    write_viewport(&gpu, &vp);
    let text = TextRenderer::new(&gpu, &vp, 1.0);
    let white = pack_rgba(255, 255, 255, 255);

    let glyphs = [
        GlyphInstance { x: 20.0, y: 20.0, ch: 'M' as u32, color: white, small: false },
        GlyphInstance { x: 140.0, y: 20.0, ch: 'M' as u32, color: white, small: true },
    ];
    let mut batch = text.create_batch(&gpu);
    batch.set_glyphs(&gpu.queue, &glyphs);

    let data = render_and_read(&gpu, &mut |pass| batch.draw(pass));
    let lg_ink = ink_pixels(&data, 10, 60, 10, 50);
    let sm_ink = ink_pixels(&data, 130, 180, 10, 50);
    assert!(sm_ink > 0, "small glyph rendered");
    assert!(
        lg_ink > sm_ink,
        "large atlas glyph should cover more pixels (lg {lg_ink} vs sm {sm_ink})"
    );
}

#[test]
fn label_batch_two_segments() {
    let gpu = gpu_or_skip!();
    let vp = ViewportBuffer::new(&gpu.device);
    write_viewport(&gpu, &vp);
    let text = TextRenderer::new(&gpu, &vp, 1.0);
    let labels = LabelRenderer::new(&gpu, &text);

    let mut scene = SceneBuffers::new(&gpu.device, &gpu.queue, &[RowInfo::default()], &[], &[]);
    scene.set_row_layout(&gpu.queue, &[(4.0, 20.0)]);

    // Two pills on row 0: [0,100) labeled "A", [100,240) labeled "BC".
    let segments = [
        PackedSegment { t_start: 0, t_end: 100, row_flags: 0 },
        PackedSegment { t_start: 100, t_end: 240, row_flags: 0 },
    ];
    let label_bytes = b"ABC";
    let label_offsets = [0u32, 1, 3];

    let batch = labels.build(&gpu, &vp, &scene, &segments, label_bytes, &label_offsets, None, false);
    // Instance count == glyph count: 1 ("A") + 2 ("BC").
    assert_eq!(batch.glyph_count, 3);

    let data = render_and_read(&gpu, &mut |pass| batch.draw(pass));

    // "A" centered in the visible pill body [0, 98): ink near x=49, and only
    // within the first segment's x-range.
    let a_ink = ink_pixels(&data, 35, 65, 0, 32);
    assert!(a_ink > 5, "label 'A' ink within segment 1's x-range, got {a_ink}");
    // "BC" centered in [100, 238): ink near x=169.
    let bc_ink = ink_pixels(&data, 150, 190, 0, 32);
    assert!(bc_ink > 10, "label 'BC' ink within segment 2's x-range, got {bc_ink}");
    // Nothing outside the two label spots.
    let total = ink_pixels(&data, 0, W, 0, H);
    assert_eq!(total, a_ink + bc_ink, "no ink outside the segment x-ranges");
    assert!(ink_pixels(&data, 0, 30, 0, H) == 0 && ink_pixels(&data, 70, 145, 0, H) == 0);

    // Append fast path: same prefix + one appended segment ("D" — its pill is
    // too narrow to draw, but the instance is still expanded).
    let segments3 = [
        segments[0],
        segments[1],
        PackedSegment { t_start: 240, t_end: 252, row_flags: 0 },
    ];
    let label_bytes3 = b"ABCD";
    let label_offsets3 = [0u32, 1, 3, 4];
    let batch2 = labels.build(
        &gpu, &vp, &scene, &segments3, label_bytes3, &label_offsets3, Some(batch), true,
    );
    assert_eq!(batch2.glyph_count, 4, "append fast path expands only the new segment");

    // The resident prefix still renders identically.
    let data2 = render_and_read(&gpu, &mut |pass| batch2.draw(pass));
    assert_eq!(ink_pixels(&data2, 35, 65, 0, 32), a_ink);
    assert_eq!(ink_pixels(&data2, 150, 190, 0, 32), bc_ink);
}
