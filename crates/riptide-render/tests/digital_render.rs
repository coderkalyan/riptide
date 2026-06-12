//! Headless render test for the digital pipelines (unit U6): builds a tiny
//! hand-made PackOutput-style fixture (one 1-bit row with 0/1/X/Z segments,
//! one 8-bit multi row), renders both variants into an offscreen RGBA8
//! texture, reads it back and asserts on pixels. The X-vs-Z color assertions
//! pin the `F_HATCH_COLOR` predicate flip for the tide.rs X/Z plane swap
//! (MIGRATION.md): X = (x0 1, x1 1) hatches in the x-color (red-ish),
//! Z = (x0 0, x1 1) hatches in the z-color (yellow).

use riptide_contract::gpu::{FLAG_SHADE, PackedSegment, RowInfo, ViewportUniform};
use riptide_render::colors::ColorBuffer;
use riptide_render::device::{Gpu, ViewportBuffer};
use riptide_render::digital::{DigitalContext, Variant};
use riptide_render::scene::SceneBuffers;

const WIDTH: u32 = 128; // 128 px × 4 B = 512 B/row — already 256-aligned for readback
const HEIGHT: u32 = 40;
const ROW_H: f32 = 20.0;

// frame.ts CLEAR_VALUE, as raw RGBA8 (Rgba8Unorm, no sRGB encode).
const BG: [u8; 3] = [27, 29, 33];

fn try_gpu() -> Option<Gpu> {
    let instance = wgpu::Instance::new(&wgpu::InstanceDescriptor {
        backends: wgpu::Backends::all(),
        ..Default::default()
    });
    let adapter = match pollster::block_on(instance.request_adapter(&wgpu::RequestAdapterOptions {
        power_preference: wgpu::PowerPreference::None,
        force_fallback_adapter: false,
        compatible_surface: None,
    })) {
        Ok(a) => a,
        Err(e) => {
            eprintln!("WARNING: no wgpu adapter available, skipping headless render test: {e}");
            return None;
        }
    };
    let (device, queue) =
        match pollster::block_on(adapter.request_device(&wgpu::DeviceDescriptor::default())) {
            Ok(dq) => dq,
            Err(e) => {
                eprintln!("WARNING: wgpu device request failed, skipping headless render test: {e}");
                return None;
            }
        };
    Some(Gpu {
        device,
        queue,
        format: wgpu::TextureFormat::Rgba8Unorm,
    })
}

/// Renders one frame (clear + the given pipelines) and reads back RGBA8 rows.
fn render_and_read_back(gpu: &Gpu, pipelines: &[&riptide_render::digital::SignalPipeline]) -> Vec<u8> {
    let texture = gpu.device.create_texture(&wgpu::TextureDescriptor {
        label: Some("test-target"),
        size: wgpu::Extent3d {
            width: WIDTH,
            height: HEIGHT,
            depth_or_array_layers: 1,
        },
        mip_level_count: 1,
        sample_count: 1,
        dimension: wgpu::TextureDimension::D2,
        format: gpu.format,
        usage: wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::COPY_SRC,
        view_formats: &[],
    });
    let view = texture.create_view(&wgpu::TextureViewDescriptor::default());

    let bytes_per_row = WIDTH * 4;
    assert_eq!(bytes_per_row % 256, 0, "readback rows must be 256-aligned");
    let readback = gpu.device.create_buffer(&wgpu::BufferDescriptor {
        label: Some("test-readback"),
        size: (bytes_per_row * HEIGHT) as u64,
        usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
        mapped_at_creation: false,
    });

    let mut encoder = gpu
        .device
        .create_command_encoder(&wgpu::CommandEncoderDescriptor { label: None });
    {
        let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
            label: Some("test-pass"),
            color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                view: &view,
                depth_slice: None,
                resolve_target: None,
                ops: wgpu::Operations {
                    load: wgpu::LoadOp::Clear(riptide_render::frame::CLEAR_VALUE),
                    store: wgpu::StoreOp::Store,
                },
            })],
            depth_stencil_attachment: None,
            timestamp_writes: None,
            occlusion_query_set: None,
        });
        for p in pipelines {
            p.draw(&mut pass);
        }
    }
    encoder.copy_texture_to_buffer(
        texture.as_image_copy(),
        wgpu::TexelCopyBufferInfo {
            buffer: &readback,
            layout: wgpu::TexelCopyBufferLayout {
                offset: 0,
                bytes_per_row: Some(bytes_per_row),
                rows_per_image: None,
            },
        },
        wgpu::Extent3d {
            width: WIDTH,
            height: HEIGHT,
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

fn pixel(data: &[u8], x: u32, y: u32) -> [u8; 4] {
    let i = (y * WIDTH * 4 + x * 4) as usize;
    [data[i], data[i + 1], data[i + 2], data[i + 3]]
}

fn band_has(
    data: &[u8],
    x0: u32,
    x1: u32,
    y0: u32,
    y1: u32,
    pred: impl Fn([u8; 4]) -> bool,
) -> bool {
    (y0..y1).any(|y| (x0..x1).any(|x| pred(pixel(data, x, y))))
}

fn non_bg(p: [u8; 4]) -> bool {
    let d = |a: u8, b: u8| a.abs_diff(b);
    d(p[0], BG[0]) > 8 || d(p[1], BG[1]) > 8 || d(p[2], BG[2]) > 8
}

/// Two rows: row 0 = 1-bit (single variant) with segments 0 / 1 / X / Z;
/// row 1 = 8-bit (multi variant) with two shaded value pills.
/// Samples use the tide.rs plane convention: 0=(0,0), 1=(1,0), X=(1,1), Z=(0,1)
/// as (x0, x1).
fn build_fixture(gpu: &Gpu) -> (ViewportBuffer, ColorBuffer, SceneBuffers, DigitalContext) {
    // Row 0 samples (1 byte each): 0, 1, X, Z.
    // Row 1 samples (1 byte each, 8-bit): 0xAB, 0xCD (defined → x1 plane 0).
    let x0_pool: Vec<u8> = vec![0x00, 0x01, 0x01, 0x00, 0xAB, 0xCD, 0, 0]; // padded to 8
    let x1_pool: Vec<u8> = vec![0x00, 0x00, 0x01, 0x01, 0x00, 0x00, 0, 0];

    let row_infos = [
        RowInfo {
            x0_offset: 0,
            x1_offset: 0,
            bytes_per_sample: 1,
            segment_start: 0,
            ..Default::default()
        },
        RowInfo {
            x0_offset: 4,
            x1_offset: 4,
            bytes_per_sample: 1,
            segment_start: 0,
            ..Default::default()
        },
    ];

    let viewport = ViewportBuffer::new(&gpu.device);
    viewport.write(
        &gpu.queue,
        &ViewportUniform::new(1.0, 0.0, WIDTH as f32, HEIGHT as f32, ROW_H, 1.0, -1, 0.0),
    );

    let colors = ColorBuffer::new(&gpu.device);
    // Packed 0xAABBGGRR: row 0 pure green, row 1 pure blue — both far from the
    // shader's x-color (red-ish) and z-color (yellow).
    colors.write(&gpu.queue, &[0xFF00_FF00, 0xFFFF_0000]);

    let mut scene = SceneBuffers::new(&gpu.device, &gpu.queue, &row_infos, &x0_pool, &x1_pool);
    scene.set_row_layout(&gpu.queue, &[(0.0, ROW_H), (ROW_H, ROW_H)]);

    let ctx = DigitalContext::new(gpu);
    (viewport, colors, scene, ctx)
}

fn single_segments() -> Vec<PackedSegment> {
    let row = 0u32;
    vec![
        PackedSegment { t_start: 0, t_end: 32, row_flags: row },
        PackedSegment { t_start: 32, t_end: 64, row_flags: row },
        PackedSegment { t_start: 64, t_end: 96, row_flags: row | FLAG_SHADE },
        PackedSegment { t_start: 96, t_end: 128, row_flags: row | FLAG_SHADE },
    ]
}

fn multi_segments() -> Vec<PackedSegment> {
    let row = 1u32;
    vec![
        PackedSegment { t_start: 0, t_end: 64, row_flags: row | FLAG_SHADE },
        PackedSegment { t_start: 64, t_end: 128, row_flags: row | FLAG_SHADE },
    ]
}

#[test]
fn digital_pipelines_render_rows_and_pin_xz_colors() {
    let Some(gpu) = try_gpu() else { return };
    let (viewport, colors, scene, ctx) = build_fixture(&gpu);

    let single = ctx.bind(&gpu, Variant::Single, &single_segments(), &viewport, &colors, &scene);
    let multi = ctx.bind(&gpu, Variant::Multi, &multi_segments(), &viewport, &colors, &scene);
    assert_eq!(single.segment_count, 4);
    assert_eq!(multi.segment_count, 2);

    let data = render_and_read_back(&gpu, &[&single, &multi]);

    // Each row's band has non-background pixels.
    assert!(band_has(&data, 0, WIDTH, 0, 20, non_bg), "row 0 band is empty");
    assert!(band_has(&data, 0, WIDTH, 20, HEIGHT, non_bg), "row 1 band is empty");

    // Row colors appear: green low-line in row 0's value-0 region…
    assert!(
        band_has(&data, 2, 30, 1, 19, |p| p[1] > 150 && p[0] < 100 && p[2] < 100),
        "row 0 green line missing"
    );
    // …and the blue fill/border in row 1's pill.
    assert!(
        band_has(&data, 4, WIDTH - 4, 21, HEIGHT - 1, |p| p[2] > 150 && p[0] < 100),
        "row 1 blue pill missing"
    );

    // The F_HATCH_COLOR flip (tide.rs X/Z plane swap, MIGRATION.md):
    // X = (x0 1, x1 1) must hatch in the x-color (red-ish ~(245,114,114));
    // Z = (x0 0, x1 1) must hatch in the z-color (yellow ~(255,220,0)).
    let x_colored = |p: [u8; 4]| p[0] > 200 && (80..180).contains(&p[1]) && (80..180).contains(&p[2]);
    let z_colored = |p: [u8; 4]| p[0] > 200 && p[1] > 180 && p[2] < 100;
    // Bands inset 2 px from segment boundaries and the pill's vertical gap.
    assert!(
        band_has(&data, 66, 94, 4, 16, x_colored),
        "x segment is not hatched in the x-color (red-ish) — F_HATCH_COLOR flip broken?"
    );
    assert!(
        !band_has(&data, 66, 94, 4, 16, z_colored),
        "x segment contains z-color (yellow) pixels — F_HATCH_COLOR flip broken?"
    );
    assert!(
        band_has(&data, 98, 126, 4, 16, z_colored),
        "z segment is not hatched in the z-color (yellow) — F_HATCH_COLOR flip broken?"
    );
    assert!(
        !band_has(&data, 98, 126, 4, 16, x_colored),
        "z segment contains x-color (red-ish) pixels — F_HATCH_COLOR flip broken?"
    );
}

#[test]
fn empty_scene_binds_and_draws() {
    // An empty scene (fresh trace, nothing active) must still validate: the
    // segment/rowInfo buffers are zero-length and get padded to one binding
    // stride (see digital.ts writeStorage / scene.rs storage()).
    let Some(gpu) = try_gpu() else { return };

    let viewport = ViewportBuffer::new(&gpu.device);
    viewport.write(
        &gpu.queue,
        &ViewportUniform::new(1.0, 0.0, WIDTH as f32, HEIGHT as f32, ROW_H, 1.0, -1, 0.0),
    );
    let colors = ColorBuffer::new(&gpu.device);
    colors.write(&gpu.queue, &[]);
    let scene = SceneBuffers::new(&gpu.device, &gpu.queue, &[], &[], &[]);
    let ctx = DigitalContext::new(&gpu);

    let single = ctx.bind(&gpu, Variant::Single, &[], &viewport, &colors, &scene);
    let multi = ctx.bind(&gpu, Variant::Multi, &[], &viewport, &colors, &scene);
    assert_eq!(single.segment_count, 0);
    assert_eq!(multi.segment_count, 0);

    // Validation errors are fatal by default in wgpu — reaching the readback
    // with every pixel at the clear color means the empty draw validated.
    let data = render_and_read_back(&gpu, &[&single, &multi]);
    assert!(
        !band_has(&data, 0, WIDTH, 0, HEIGHT, non_bg),
        "empty scene rendered non-background pixels"
    );
}
