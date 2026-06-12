//! Headless render tests for the U7 batch renderers (lines.rs / rect.rs):
//! draw into an offscreen RGBA8 target with a hand-built viewport uniform,
//! read back, and probe pixels. Skips (with a warning) when no wgpu adapter
//! exists in the environment.

use riptide_contract::geometry::{LineInstance, RectInstance};
use riptide_contract::gpu::ViewportUniform;
use riptide_render::device::{Gpu, ViewportBuffer};
use riptide_render::lines::{LineBatch, LineRenderer, MAX_LINES};
use riptide_render::rect::{MAX_RECTS, RectBatch, RectRenderer};

const W: u32 = 128;
const H: u32 = 64;
const OPAQUE_WHITE: u32 = 0xffff_ffff;

fn gpu() -> Option<Gpu> {
    let instance = wgpu::Instance::default();
    let adapter = match pollster::block_on(instance.request_adapter(
        &wgpu::RequestAdapterOptions {
            power_preference: wgpu::PowerPreference::None,
            force_fallback_adapter: false,
            compatible_surface: None,
        },
    )) {
        Ok(a) => a,
        Err(e) => {
            eprintln!("SKIP: no wgpu adapter available ({e})");
            return None;
        }
    };
    let (device, queue) = match pollster::block_on(adapter.request_device(
        &wgpu::DeviceDescriptor {
            label: Some("u7-test"),
            required_features: wgpu::Features::empty(),
            required_limits: wgpu::Limits::downlevel_defaults(),
            ..Default::default()
        },
    )) {
        Ok(dq) => dq,
        Err(e) => {
            eprintln!("SKIP: wgpu device request failed ({e})");
            return None;
        }
    };
    Some(Gpu {
        device,
        queue,
        format: wgpu::TextureFormat::Rgba8Unorm,
    })
}

/// Standard viewport: W×H CSS px at dpr 1 (CSS px == device px), 1 tick/px.
fn viewport(gpu: &Gpu) -> ViewportBuffer {
    let vp = ViewportBuffer::new(&gpu.device);
    vp.write(
        &gpu.queue,
        &ViewportUniform::new(1.0, 0.0, W as f32, H as f32, 20.0, 1.0, -1, 0.0),
    );
    vp
}

/// Renders one pass (cleared to transparent black) via `draw` and reads the
/// RGBA8 target back. W*4 = 512 B/row satisfies the 256-alignment rule.
fn render(gpu: &Gpu, draw: impl FnOnce(&mut wgpu::RenderPass<'_>)) -> Vec<u8> {
    let tex = gpu.device.create_texture(&wgpu::TextureDescriptor {
        label: Some("u7-target"),
        size: wgpu::Extent3d {
            width: W,
            height: H,
            depth_or_array_layers: 1,
        },
        mip_level_count: 1,
        sample_count: 1,
        dimension: wgpu::TextureDimension::D2,
        format: gpu.format,
        usage: wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::COPY_SRC,
        view_formats: &[],
    });
    let view = tex.create_view(&wgpu::TextureViewDescriptor::default());

    let readback = gpu.device.create_buffer(&wgpu::BufferDescriptor {
        label: Some("u7-readback"),
        size: (W * H * 4) as u64,
        usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
        mapped_at_creation: false,
    });

    let mut encoder = gpu
        .device
        .create_command_encoder(&wgpu::CommandEncoderDescriptor::default());
    {
        let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
            label: Some("u7-pass"),
            color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                view: &view,
                depth_slice: None,
                resolve_target: None,
                ops: wgpu::Operations {
                    load: wgpu::LoadOp::Clear(wgpu::Color::TRANSPARENT),
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
                rows_per_image: Some(H),
            },
        },
        wgpu::Extent3d {
            width: W,
            height: H,
            depth_or_array_layers: 1,
        },
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

fn alpha(data: &[u8], x: u32, y: u32) -> u8 {
    assert!(x < W && y < H, "probe out of bounds");
    data[((y * W + x) * 4 + 3) as usize]
}

const ON: u8 = 128; // alpha >= ON counts as drawn
const OFF: u8 = 32; // alpha <= OFF counts as background

// ---------------------------------------------------------------------------
// Lines
// ---------------------------------------------------------------------------

fn line_batch(gpu: &Gpu, vp: &ViewportBuffer, lines: &[LineInstance]) -> LineBatch {
    let renderer = LineRenderer::new(gpu, vp);
    let mut batch = renderer.create_batch(gpu);
    batch.set_lines(&gpu.queue, lines);
    batch
}

#[test]
fn lines_solid_dashed_fullheight() {
    let Some(gpu) = gpu() else { return };
    let vp = viewport(&gpu);

    // Solid full-height at x=10; solid pill-anchored (top y=8) at x=30;
    // dashed full-height at x=50. Lines are LEFT-aligned, 2.5 px wide, so
    // column x+1 is safely interior.
    let lines = [
        LineInstance {
            x: 10.0,
            color: OPAQUE_WHITE,
            dashed: false,
            full_height: true,
        },
        LineInstance {
            x: 30.0,
            color: OPAQUE_WHITE,
            dashed: false,
            full_height: false,
        },
        LineInstance {
            x: 50.0,
            color: OPAQUE_WHITE,
            dashed: true,
            full_height: true,
        },
    ];
    let batch = line_batch(&gpu, &vp, &lines);
    let img = render(&gpu, |pass| batch.draw(pass));

    // Solid full-height: covered top to bottom.
    assert!(alpha(&img, 11, 0) >= ON, "full-height line reaches y=0");
    assert!(alpha(&img, 11, H / 2) >= ON);
    assert!(alpha(&img, 11, H - 1) >= ON);
    // Left-aligned: nothing left of x=10, body at x=10..12.
    assert!(alpha(&img, 9, H / 2) <= OFF, "no pixels left of the left edge");
    assert!(alpha(&img, 10, H / 2) >= ON);

    // Non-full-height: top starts at y=8 (inside the flag pill).
    assert!(alpha(&img, 31, 2) <= OFF, "pill-anchored line absent above y=8");
    assert!(alpha(&img, 31, 12) >= ON);
    assert!(alpha(&img, 31, H - 1) >= ON);

    // Dashed: the column has both on and off runs; the solid column has none.
    let column = |x: u32| (0..H).map(|y| alpha(&img, x, y)).collect::<Vec<_>>();
    let dashed = column(51);
    let solid = column(11);
    let on = |c: &[u8]| c.iter().filter(|&&a| a >= ON).count();
    let off = |c: &[u8]| c.iter().filter(|&&a| a <= OFF).count();
    assert_eq!(off(&solid), 0, "solid line has no gaps");
    assert!(on(&dashed) >= 8, "dashed line has lit dashes");
    assert!(off(&dashed) >= 8, "dashed line has gaps");

    // Far from any line: background.
    assert_eq!(alpha(&img, 100, H / 2), 0);
}

#[test]
fn lines_count_clamped_and_empty_draw() {
    let Some(gpu) = gpu() else { return };
    let vp = viewport(&gpu);
    let renderer = LineRenderer::new(&gpu, &vp);
    let mut batch = renderer.create_batch(&gpu);

    let many = vec![LineInstance::default(); MAX_LINES + 100];
    batch.set_lines(&gpu.queue, &many);
    assert_eq!(batch.line_count, MAX_LINES as u32);

    batch.set_lines(&gpu.queue, &[]);
    assert_eq!(batch.line_count, 0);
    // Empty draw encodes nothing and the frame stays clear.
    let img = render(&gpu, |pass| batch.draw(pass));
    assert!(img.iter().all(|&b| b == 0));
}

// ---------------------------------------------------------------------------
// Rects
// ---------------------------------------------------------------------------

fn rect_batch(gpu: &Gpu, vp: &ViewportBuffer, rects: &[RectInstance]) -> RectBatch {
    let renderer = RectRenderer::new(gpu, vp);
    let mut batch = renderer.create_batch(gpu);
    batch.set_rects(&gpu.queue, rects);
    batch
}

fn plain_rect(x: f32, y: f32, w: f32, h: f32) -> RectInstance {
    RectInstance {
        x,
        y,
        w,
        h,
        color: OPAQUE_WHITE,
        ..Default::default()
    }
}

#[test]
fn rects_plain_crosshatch_rounded() {
    let Some(gpu) = gpu() else { return };
    let vp = viewport(&gpu);

    let rects = [
        plain_rect(8.0, 8.0, 24.0, 16.0),
        RectInstance {
            crosshatch: true,
            ..plain_rect(40.0, 8.0, 24.0, 16.0)
        },
        RectInstance {
            rounded: true,
            ..plain_rect(72.0, 8.0, 24.0, 16.0)
        },
    ];
    let batch = rect_batch(&gpu, &vp, &rects);
    let img = render(&gpu, |pass| batch.draw(pass));

    // Plain: uniformly opaque over its whole area, background outside.
    for y in 8..24 {
        for x in 8..32 {
            assert_eq!(alpha(&img, x, y), 255, "plain rect interior at ({x},{y})");
        }
    }
    assert_eq!(alpha(&img, 4, 16), 0);
    assert_eq!(alpha(&img, 16, 30), 0);

    // Crosshatch: same-size area now has both lit stripes and gaps.
    let mut lit = 0usize;
    let mut gap = 0usize;
    for y in 8..24 {
        for x in 40..64 {
            let a = alpha(&img, x, y);
            if a >= ON {
                lit += 1;
            }
            if a <= OFF {
                gap += 1;
            }
        }
    }
    assert!(lit >= 20, "crosshatch has lit stripes (got {lit})");
    assert!(gap >= 20, "crosshatch has gaps between stripes (got {gap})");

    // Rounded: 3px-radius corners are masked out, interior + straight edge
    // midpoints stay opaque (the plain rect keeps its corner pixel).
    assert_eq!(alpha(&img, 8, 8), 255, "plain rect corner is square");
    assert!(alpha(&img, 72, 8) <= OFF, "rounded top-left corner is masked");
    assert!(alpha(&img, 95, 8) <= OFF, "rounded top-right corner is masked");
    assert_eq!(alpha(&img, 84, 16), 255, "rounded rect interior");
    assert_eq!(alpha(&img, 84, 8), 255, "straight top edge stays sharp");
    assert_eq!(alpha(&img, 72, 16), 255, "straight left edge stays sharp");
}

#[test]
fn rects_caret_directions() {
    let Some(gpu) = gpu() else { return };
    let vp = viewport(&gpu);

    // Caret apex sits at the rect center; arms are ~5 px chevrons. "<" (caret
    // only) opens right of the apex; ">" (caret_right) opens left.
    let left = RectInstance {
        caret: true,
        ..plain_rect(8.0, 32.0, 16.0, 16.0)
    }; // apex (16, 40)
    let right = RectInstance {
        caret: true,
        caret_right: true,
        ..plain_rect(40.0, 32.0, 16.0, 16.0)
    }; // apex (48, 40)
    let solid = plain_rect(72.0, 32.0, 16.0, 16.0);
    let batch = rect_batch(&gpu, &vp, &[left, right, solid]);
    let img = render(&gpu, |pass| batch.draw(pass));

    // Caret pixels differ from a solid rect: the rect corner is empty, the
    // apex is lit. (Solid rect covers everything.)
    assert!(alpha(&img, 9, 33) <= OFF, "caret rect corner is background");
    assert_eq!(alpha(&img, 73, 33), 255, "solid rect corner is opaque");
    assert!(alpha(&img, 16, 40) >= ON, "caret apex is lit");

    // Direction: probe ±(2.5, -2.5) around each apex — the arm side is lit,
    // the point side is not. "<" arms extend right of the apex.
    assert!(alpha(&img, 18, 37) >= ON, "'<' arm right of apex");
    assert!(alpha(&img, 13, 37) <= OFF, "'<' empty left of apex");
    // ">" mirrored: arms extend left of the apex.
    assert!(alpha(&img, 45, 37) >= ON, "'>' arm left of apex");
    assert!(alpha(&img, 50, 37) <= OFF, "'>' empty right of apex");
}

#[test]
fn rects_draw_range_slices() {
    let Some(gpu) = gpu() else { return };
    let vp = viewport(&gpu);

    let rects = [
        plain_rect(8.0, 8.0, 16.0, 16.0),
        plain_rect(40.0, 8.0, 16.0, 16.0),
        plain_rect(72.0, 8.0, 16.0, 16.0),
    ];
    let batch = rect_batch(&gpu, &vp, &rects);
    let img = render(&gpu, |pass| batch.draw_range(pass, 1, 1));

    // Only the middle instance draws; the excluded instances' areas stay
    // background.
    assert_eq!(alpha(&img, 48, 16), 255, "instance 1 drawn");
    assert_eq!(alpha(&img, 16, 16), 0, "instance 0 excluded");
    assert_eq!(alpha(&img, 80, 16), 0, "instance 2 excluded");

    // Full draw still renders all three.
    let img = render(&gpu, |pass| batch.draw(pass));
    assert_eq!(alpha(&img, 16, 16), 255);
    assert_eq!(alpha(&img, 48, 16), 255);
    assert_eq!(alpha(&img, 80, 16), 255);
}

#[test]
fn rects_count_clamped() {
    let Some(gpu) = gpu() else { return };
    let vp = viewport(&gpu);
    let renderer = RectRenderer::new(&gpu, &vp);
    let mut batch = renderer.create_batch(&gpu);

    let many = vec![RectInstance::default(); MAX_RECTS + 7];
    batch.set_rects(&gpu.queue, &many);
    assert_eq!(batch.rect_count, MAX_RECTS as u32);

    batch.set_rects(&gpu.queue, &[]);
    assert_eq!(batch.rect_count, 0);
}
