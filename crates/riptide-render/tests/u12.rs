//! U12 headless tests: capture_png pitch alignment, GpuTimer, ColorBuffer.
//!
//! U6/U7/U8 batch constructors are still `todo!()` stubs while those units
//! land in parallel, so `render_frame`'s runtime path can't be exercised here
//! — it gets compile-time coverage only (see `render_frame_compiles`); its
//! runtime behavior is verified at integration (U15).

use riptide_contract::gpu::MAX_ROWS;
use riptide_render::capture::capture_png;
use riptide_render::colors::ColorBuffer;
use riptide_render::device::Gpu;
use riptide_render::frame::{CLEAR_VALUE, FrameLayers, render_frame};
use riptide_render::timing::GpuTimer;

/// Headless adapter/device, requesting `wanted` features when the adapter has
/// them. None (skip the test, with a warning) when no adapter exists.
fn request_gpu(wanted: wgpu::Features) -> Option<Gpu> {
    let instance = wgpu::Instance::default();
    let adapter =
        pollster::block_on(instance.request_adapter(&wgpu::RequestAdapterOptions::default()))
            .ok()?;
    let features = adapter.features() & wanted;
    let (device, queue) = pollster::block_on(adapter.request_device(&wgpu::DeviceDescriptor {
        label: Some("u12-test"),
        required_features: features,
        ..Default::default()
    }))
    .ok()?;
    Some(Gpu { device, queue, format: wgpu::TextureFormat::Rgba8Unorm })
}

macro_rules! gpu_or_skip {
    ($features:expr) => {
        match request_gpu($features) {
            Some(gpu) => gpu,
            None => {
                eprintln!("WARNING: no wgpu adapter available — skipping test");
                return;
            }
        }
    };
}

/// Clear-only pass into `view` — the minimal `draw` closure body.
fn clear_only(gpu: &Gpu, view: &wgpu::TextureView) {
    let mut enc = gpu.device.create_command_encoder(&wgpu::CommandEncoderDescriptor::default());
    {
        let _pass = enc.begin_render_pass(&wgpu::RenderPassDescriptor {
            label: Some("clear-only"),
            color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                view,
                depth_slice: None,
                resolve_target: None,
                ops: wgpu::Operations {
                    load: wgpu::LoadOp::Clear(CLEAR_VALUE),
                    store: wgpu::StoreOp::Store,
                },
            })],
            depth_stencil_attachment: None,
            timestamp_writes: None,
            occlusion_query_set: None,
        });
    }
    gpu.queue.submit([enc.finish()]);
}

fn assert_capture_is_clear_color(gpu: &Gpu, width: u32, height: u32) {
    let png = capture_png(gpu, width, height, &mut |view| clear_only(gpu, view))
        .expect("capture_png failed");
    let img = image::load_from_memory(&png).expect("png decode failed").to_rgba8();
    assert_eq!(img.dimensions(), (width, height));

    let expected = [
        (CLEAR_VALUE.r * 255.0).round() as u8,
        (CLEAR_VALUE.g * 255.0).round() as u8,
        (CLEAR_VALUE.b * 255.0).round() as u8,
        (CLEAR_VALUE.a * 255.0).round() as u8,
    ];
    for (x, y, px) in img.enumerate_pixels() {
        for (c, (&got, &want)) in px.0.iter().zip(&expected).enumerate() {
            // ±1 absorbs driver unorm rounding; a de-pad bug would be way off.
            assert!(
                got.abs_diff(want) <= 1,
                "pixel ({x},{y}) channel {c}: got {got}, want {want} (size {width}x{height})"
            );
        }
    }
}

/// 4*64 = 256 bytes per row — already a multiple of the copy pitch alignment.
#[test]
fn capture_clear_aligned_width() {
    let gpu = gpu_or_skip!(wgpu::Features::empty());
    assert_capture_is_clear_color(&gpu, 64, 16);
}

/// 4*250 = 1000 bytes per row — padded to 1024; exercises the de-pad path.
#[test]
fn capture_clear_unaligned_width() {
    let gpu = gpu_or_skip!(wgpu::Features::empty());
    assert_capture_is_clear_color(&gpu, 250, 33);
}

#[test]
fn gpu_timer_reports_pass_duration() {
    let gpu = gpu_or_skip!(wgpu::Features::TIMESTAMP_QUERY);

    if !gpu.device.features().contains(wgpu::Features::TIMESTAMP_QUERY) {
        assert!(GpuTimer::new(&gpu).is_none(), "timer must be None without the feature");
        eprintln!("WARNING: adapter lacks TIMESTAMP_QUERY — only checked the None path");
        return;
    }
    let mut timer = GpuTimer::new(&gpu).expect("feature present but GpuTimer::new gave None");

    let texture = gpu.device.create_texture(&wgpu::TextureDescriptor {
        label: Some("timer-target"),
        size: wgpu::Extent3d { width: 16, height: 16, depth_or_array_layers: 1 },
        mip_level_count: 1,
        sample_count: 1,
        dimension: wgpu::TextureDimension::D2,
        format: gpu.format,
        usage: wgpu::TextureUsages::RENDER_ATTACHMENT,
        view_formats: &[],
    });
    let view = texture.create_view(&wgpu::TextureViewDescriptor::default());

    // Drive the per-frame protocol a few times; the readback lands a frame or
    // two late.
    for _ in 0..20 {
        let mut enc =
            gpu.device.create_command_encoder(&wgpu::CommandEncoderDescriptor::default());
        {
            let _pass = enc.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some("timed-pass"),
                color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                    view: &view,
                    depth_slice: None,
                    resolve_target: None,
                    ops: wgpu::Operations {
                        load: wgpu::LoadOp::Clear(CLEAR_VALUE),
                        store: wgpu::StoreOp::Store,
                    },
                })],
                depth_stencil_attachment: None,
                timestamp_writes: timer.pass_timestamp_writes(),
                occlusion_query_set: None,
            });
        }
        timer.resolve(&mut enc);
        gpu.queue.submit([enc.finish()]);
        timer.readback();
        let _ = gpu.device.poll(wgpu::PollType::wait_indefinitely());
        if let Some(ms) = timer.read(&gpu.device) {
            assert!(ms >= 0.0, "negative pass duration {ms}");
            return;
        }
    }
    panic!("GpuTimer never reported a result after 20 frames");
}

#[test]
fn color_buffer_normalizes_packed_rgba() {
    let gpu = gpu_or_skip!(wgpu::Features::empty());

    let colors = ColorBuffer::new(&gpu.device);
    // packRgba order: byte0=r, byte1=g, byte2=b, byte3=a (0xAABBGGRR LE).
    colors.write(&gpu.queue, &[0xff00_00ff, 0x8060_4020]);

    let size = (MAX_ROWS * 16) as u64;
    let staging = gpu.device.create_buffer(&wgpu::BufferDescriptor {
        label: Some("colors-staging"),
        size,
        usage: wgpu::BufferUsages::MAP_READ | wgpu::BufferUsages::COPY_DST,
        mapped_at_creation: false,
    });
    let mut enc = gpu.device.create_command_encoder(&wgpu::CommandEncoderDescriptor::default());
    enc.copy_buffer_to_buffer(&colors.buf, 0, &staging, 0, size);
    gpu.queue.submit([enc.finish()]);

    let slice = staging.slice(..);
    let (tx, rx) = std::sync::mpsc::channel();
    slice.map_async(wgpu::MapMode::Read, move |res| {
        let _ = tx.send(res);
    });
    gpu.device.poll(wgpu::PollType::wait_indefinitely()).expect("poll failed");
    rx.recv().expect("map callback dropped").expect("map failed");

    let data = slice.get_mapped_range();
    let floats: &[f32] = bytemuck::cast_slice(&data);
    assert_eq!(floats.len(), MAX_ROWS * 4);

    let row = |i: usize| &floats[i * 4..i * 4 + 4];
    assert_eq!(row(0), &[1.0, 0.0, 0.0, 1.0]);
    let expect1 = [
        0x20 as f32 / 255.0,
        0x40 as f32 / 255.0,
        0x60 as f32 / 255.0,
        0x80 as f32 / 255.0,
    ];
    assert_eq!(row(1), &expect1);
    // Missing rows zero-filled.
    for i in 2..MAX_ROWS {
        assert_eq!(row(i), &[0.0; 4], "row {i} not zero");
    }
}

/// Compile-time-only coverage for `render_frame`: U6/U7/U8 batches can't be
/// instantiated until those units merge (constructors are `todo!()`), so this
/// just pins the call signature. Runtime coverage comes at integration.
#[allow(dead_code)]
fn render_frame_compiles(
    gpu: &Gpu,
    view: &wgpu::TextureView,
    layers: &FrameLayers<'_>,
    timer: &mut GpuTimer,
) {
    render_frame(gpu, view, layers, Some(timer));
    render_frame(gpu, view, layers, None);
}
