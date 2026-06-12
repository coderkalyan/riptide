//! The native render loop: vsync-paced present with a dirty-flag scheme (the
//! old rAF `needsRender`), driving `Engine::frame()` → repack/geometry →
//! `riptide_render::frame::render_frame`.
//!
//! OWNED BY UNIT U1 (pacing/threading skeleton, proven with a test pipeline);
//! wired to the real engine + batches at INTEGRATION (U15).
//!
//! Pacing: a dedicated render thread sleeps on a condvar until something marks
//! the frame dirty (`RenderHandle::request_redraw`, a resize, or — for the
//! spike's animated test scene — the loop re-arming itself). Presents use
//! `PresentMode::Fifo`, so a continuously-dirty loop is throttled to the
//! display refresh by `get_current_texture()` back-pressure rather than
//! spinning. U15 replaces the self-re-arm with engine-driven dirtiness
//! (`Engine::frame().dirty` + viewport animation).

use std::sync::{Arc, Condvar, Mutex};
use std::time::Instant;

use crate::surface::GfxState;

/// Spike only: keep the test scene animating by re-marking dirty after each
/// present. With this off the thread renders once and sleeps until a resize
/// or an explicit `request_redraw`.
const DEMO_ANIMATE: bool = true;

#[derive(Default)]
struct Shared {
    dirty: bool,
    /// Latest pending physical size (coalesces bursts of resize events).
    pending_resize: Option<(u32, u32)>,
    shutdown: bool,
}

/// Cheap clonable wake-up handle owned by the window-event hook, Tauri state,
/// and (later) the engine command layer.
#[derive(Clone)]
pub struct RenderHandle {
    inner: Arc<(Mutex<Shared>, Condvar)>,
}

impl RenderHandle {
    fn new() -> Self {
        Self { inner: Arc::new((Mutex::new(Shared::default()), Condvar::new())) }
    }

    fn wake(&self, f: impl FnOnce(&mut Shared)) {
        let (lock, cv) = &*self.inner;
        f(&mut lock.lock().expect("render shared lock"));
        cv.notify_one();
    }

    pub fn request_redraw(&self) {
        self.wake(|s| s.dirty = true);
    }

    /// New physical size from `WindowEvent::Resized` / `ScaleFactorChanged`.
    pub fn resize(&self, width: u32, height: u32) {
        self.wake(|s| {
            s.pending_resize = Some((width, height));
            s.dirty = true;
        });
    }

    pub fn shutdown(&self) {
        self.wake(|s| s.shutdown = true);
    }

    /// Blocks until dirty (or shutdown → `None`); returns any pending resize.
    fn wait_dirty(&self) -> Option<Option<(u32, u32)>> {
        let (lock, cv) = &*self.inner;
        let mut s = lock.lock().expect("render shared lock");
        while !s.dirty && !s.shutdown {
            s = cv.wait(s).expect("render shared lock");
        }
        if s.shutdown {
            return None;
        }
        s.dirty = false;
        Some(s.pending_resize.take())
    }
}

/// Spawns the render thread against an already-configured surface and returns
/// the wake-up handle. The first frame is queued immediately.
pub fn start(gfx: Arc<GfxState>) -> RenderHandle {
    let handle = RenderHandle::new();
    let thread_handle = handle.clone();
    std::thread::Builder::new()
        .name("riptide-render".into())
        .spawn(move || run(&gfx, &thread_handle))
        .expect("spawn render thread");
    handle.request_redraw();
    handle
}

fn run(gfx: &GfxState, handle: &RenderHandle) {
    let scene = TestScene::new(gfx);
    let t0 = Instant::now();
    loop {
        let Some(resize) = handle.wait_dirty() else {
            return; // shutdown
        };
        if let Some((w, h)) = resize {
            gfx.reconfigure(w, h);
        }

        let frame = match gfx.surface.get_current_texture() {
            Ok(frame) => frame,
            Err(wgpu::SurfaceError::Lost | wgpu::SurfaceError::Outdated) => {
                gfx.reconfigure_current();
                handle.request_redraw();
                continue;
            }
            Err(wgpu::SurfaceError::Timeout) => {
                handle.request_redraw();
                continue;
            }
            Err(err) => {
                eprintln!("[riptide-gfx] surface unrecoverable ({err}); render loop stopped");
                return;
            }
        };

        scene.render(gfx, &frame.texture, t0.elapsed().as_secs_f32());
        frame.present();

        if DEMO_ANIMATE {
            handle.request_redraw(); // vsync-paced by Fifo back-pressure
        }
    }
}

/// The spike's visible proof: clear to the app background + one orbiting
/// orange quad, drawn UNDER the transparent webview DOM. Replaced by the real
/// scene (`riptide_render::frame::render_frame`) at U15.
struct TestScene {
    pipeline: wgpu::RenderPipeline,
    uniform: wgpu::Buffer,
    bind_group: wgpu::BindGroup,
}

const TEST_SHADER: &str = r#"
struct U { t: f32, pad0: f32, pad1: f32, pad2: f32 }
@group(0) @binding(0) var<uniform> u: U;

struct VsOut { @builtin(position) pos: vec4f }

@vertex
fn vs_main(@builtin(vertex_index) vi: u32) -> VsOut {
    // Unit quad (triangle strip), orbiting slowly in clip space.
    let corner = vec2f(f32(vi & 1u) * 2.0 - 1.0, f32(vi >> 1u) * 2.0 - 1.0);
    let center = vec2f(sin(u.t * 0.8) * 0.55, cos(u.t * 0.5) * 0.35);
    var out: VsOut;
    out.pos = vec4f(corner * vec2f(0.18, 0.24) + center, 0.0, 1.0);
    return out;
}

@fragment
fn fs_main() -> @location(0) vec4f {
    return vec4f(0.95, 0.55, 0.15, 1.0);
}
"#;

impl TestScene {
    fn new(gfx: &GfxState) -> Self {
        let device = &gfx.device;
        let shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("u1-test-scene"),
            source: wgpu::ShaderSource::Wgsl(TEST_SHADER.into()),
        });
        let uniform = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("u1-test-uniform"),
            size: 16,
            usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });
        let bgl = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("u1-test-bgl"),
            entries: &[wgpu::BindGroupLayoutEntry {
                binding: 0,
                visibility: wgpu::ShaderStages::VERTEX,
                ty: wgpu::BindingType::Buffer {
                    ty: wgpu::BufferBindingType::Uniform,
                    has_dynamic_offset: false,
                    min_binding_size: None,
                },
                count: None,
            }],
        });
        let bind_group = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("u1-test-bg"),
            layout: &bgl,
            entries: &[wgpu::BindGroupEntry { binding: 0, resource: uniform.as_entire_binding() }],
        });
        let layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some("u1-test-layout"),
            bind_group_layouts: &[&bgl],
            push_constant_ranges: &[],
        });
        let pipeline = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some("u1-test-pipeline"),
            layout: Some(&layout),
            vertex: wgpu::VertexState {
                module: &shader,
                entry_point: Some("vs_main"),
                compilation_options: Default::default(),
                buffers: &[],
            },
            fragment: Some(wgpu::FragmentState {
                module: &shader,
                entry_point: Some("fs_main"),
                compilation_options: Default::default(),
                targets: &[Some(gfx.format().into())],
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
        Self { pipeline, uniform, bind_group }
    }

    fn render(&self, gfx: &GfxState, target: &wgpu::Texture, t: f32) {
        let mut data = [0u8; 16];
        data[0..4].copy_from_slice(&t.to_le_bytes());
        gfx.queue.write_buffer(&self.uniform, 0, &data);

        let view = target.create_view(&wgpu::TextureViewDescriptor::default());
        let mut encoder = gfx
            .device
            .create_command_encoder(&wgpu::CommandEncoderDescriptor { label: Some("u1-test") });
        {
            let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some("u1-test-pass"),
                color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                    view: &view,
                    resolve_target: None,
                    depth_slice: None,
                    ops: wgpu::Operations {
                        load: wgpu::LoadOp::Clear(riptide_render::frame::CLEAR_VALUE),
                        store: wgpu::StoreOp::Store,
                    },
                })],
                depth_stencil_attachment: None,
                timestamp_writes: None,
                occlusion_query_set: None,
            });
            pass.set_pipeline(&self.pipeline);
            pass.set_bind_group(0, &self.bind_group, &[]);
            pass.draw(0..4, 0..1);
        }
        gfx.queue.submit(Some(encoder.finish()));
    }
}
