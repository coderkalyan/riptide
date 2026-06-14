//! The native render loop: a dedicated thread that, on each wake, drives
//! `Engine::frame()` → repack/geometry → `riptide_render::frame::render_frame`
//! and presents to the window surface.
//!
//! Pacing (U1's design): the thread sleeps on a condvar until something marks
//! the frame dirty (`RenderHandle::request_redraw` from a command, a resize, or
//! a viewport animation re-arming itself). Presents use `PresentMode::Fifo`, so
//! a continuously-dirty loop is throttled to the display refresh by
//! `get_current_texture()` back-pressure rather than spinning.
//!
//! Threading: wgpu objects are `Send + Sync`; the engine is shared with the IPC
//! command handlers through `Arc<Mutex<Engine>>` and locked once per frame.
//!
//! Deferred (see `engine.rs`): value-pill labels (the digital multi pipeline
//! draws the pills; the text inside them needs the segment buffer shared with
//! `LabelRenderer`), bucket-mode bands, and reset crosshatch.

use std::sync::{Arc, Condvar, Mutex};

use riptide_contract::geometry::FrameGeometry;
use riptide_contract::gpu::{PackedSegment, RowInfo, ViewportUniform};
use riptide_render::colors::ColorBuffer;
use riptide_render::device::{Gpu, ViewportBuffer};
use riptide_render::digital::{DigitalContext, SignalPipeline, Variant};
use riptide_render::frame::{FrameLayers, render_frame};
use riptide_render::lines::{LineBatch, LineRenderer};
use riptide_render::rect::{RectBatch, RectRenderer};
use riptide_render::scene::SceneBuffers;
use riptide_render::text::{TextBatch, TextRenderer};

use crate::state::{SharedEngine, SharedEvents, emit_to, now_ms};
use crate::surface::GfxState;

#[derive(Default)]
struct Shared {
    dirty: bool,
    /// Latest pending physical size (coalesces bursts of resize events).
    pending_resize: Option<(u32, u32)>,
    shutdown: bool,
}

/// Cheap clonable wake-up handle owned by the window-event hook, the Tauri
/// command layer (managed state), and the render thread.
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

/// Spawns the render thread against an already-configured surface + the shared
/// engine/event channel, returns the wake-up handle. The first frame is queued.
pub fn start(
    gfx: Arc<GfxState>,
    engine: SharedEngine,
    events: SharedEvents,
    dpr: f32,
) -> RenderHandle {
    let handle = RenderHandle::new();
    let thread_handle = handle.clone();
    std::thread::Builder::new()
        .name("riptide-render".into())
        .spawn(move || run(&gfx, &thread_handle, &engine, &events, dpr))
        .expect("spawn render thread");
    handle.request_redraw();
    handle
}

fn run(
    gfx: &GfxState,
    handle: &RenderHandle,
    engine: &SharedEngine,
    events: &SharedEvents,
    dpr: f32,
) {
    let mut scene = Scene::new(gfx, dpr);
    // Hand the engine the atlas metrics so its geometry can lay glyphs out.
    engine.lock().expect("engine lock").set_text_metrics(scene.text.metrics());

    loop {
        let Some(resize) = handle.wait_dirty() else {
            return; // shutdown
        };
        if let Some((w, h)) = resize {
            gfx.reconfigure(w, h);
        }

        // One engine frame, snapshotted under a single lock.
        let mut snap = {
            let mut eng = engine.lock().expect("engine lock");
            let result = eng.frame(now_ms());
            let presentation = result
                .repack
                .as_ref()
                .map(|_| (eng.row_layout(), eng.row_colors(), eng.row_flags()));
            FrameSnapshot { result, presentation }
        };

        emit_to(events, std::mem::take(&mut snap.result.events));
        scene.apply(gfx, &snap);

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
        let view = frame.texture.create_view(&wgpu::TextureViewDescriptor::default());
        scene.render(&view);
        frame.present();

        // Keep animating while the viewport eases (Fifo back-pressure paces it).
        if snap.result.animating {
            handle.request_redraw();
        }
    }
}

/// Repack-frame presentation snapshot: (row layout `(y, height)`, packed-rgba
/// colors, `(hidden, selected)` flags), each indexed by row.
type Presentation = (Vec<(f32, f32)>, Vec<u32>, (Vec<bool>, Vec<bool>));

struct FrameSnapshot {
    result: riptide_core::engine::FrameResult,
    /// Present only on a repack frame.
    presentation: Option<Presentation>,
}

/// All GPU state for the real waveform scene: shared buffers + per-batch
/// renderers, rebuilt from a `PackOutput` on repack and refreshed from the
/// frame geometry every wake.
struct Scene {
    gpu: Gpu,
    viewport: ViewportBuffer,
    colors: ColorBuffer,
    digital: DigitalContext,
    /// Kept for its atlas metrics + as the batches' backing renderer.
    text: TextRenderer,

    line_bg: LineBatch,
    rect_bg: RectBatch,
    text_body: TextBatch,
    line_fg: LineBatch,
    pill_rect: RectBatch,
    pill_text: TextBatch,

    buffers: Option<SceneBuffers>,
    pipe_single: Option<SignalPipeline>,
    pipe_multi: Option<SignalPipeline>,

    /// The latest geometry's pill ranges (drawn per-pill for occlusion order).
    pill_ranges: Vec<riptide_contract::geometry::PillRange>,
    vp_uniform: ViewportUniform,
}

impl Scene {
    fn new(gfx: &GfxState, dpr: f32) -> Self {
        // The renderers borrow a `Gpu`; build one from cloned device/queue
        // handles (wgpu handles are cheap Arc-backed clones; same underlying
        // device as the surface).
        let gpu = Gpu { device: gfx.device.clone(), queue: gfx.queue.clone(), format: gfx.format() };
        let viewport = ViewportBuffer::new(&gpu.device);
        let colors = ColorBuffer::new(&gpu.device);
        let digital = DigitalContext::new(&gpu);
        let lines = LineRenderer::new(&gpu, &viewport);
        let rects = RectRenderer::new(&gpu, &viewport);
        let text = TextRenderer::new(&gpu, &viewport, dpr);

        let line_bg = lines.create_batch(&gpu);
        let rect_bg = rects.create_batch(&gpu);
        let text_body = text.create_batch(&gpu);
        let line_fg = lines.create_batch(&gpu);
        let pill_rect = rects.create_batch(&gpu);
        let pill_text = text.create_batch(&gpu);

        Self {
            gpu,
            viewport,
            colors,
            digital,
            text,
            line_bg,
            rect_bg,
            text_body,
            line_fg,
            pill_rect,
            pill_text,
            buffers: None,
            pipe_single: None,
            pipe_multi: None,
            pill_ranges: Vec::new(),
            vp_uniform: ViewportUniform::new(1.0, 0.0, 1.0, 1.0, 28.0, 1.0, -1, 28.0),
        }
    }

    /// Uploads this frame's data: viewport uniform, any repack (scene buffers +
    /// digital pipelines + colors/layout/flags), and the frame geometry.
    fn apply(&mut self, _gfx: &GfxState, snap: &FrameSnapshot) {
        if let Some(vp) = snap.result.viewport {
            self.vp_uniform = vp;
            self.viewport.write(&self.gpu.queue, &vp);
        }

        if let (Some(pack), Some((layout, row_colors, (hidden, selected)))) =
            (snap.result.repack.as_ref(), snap.presentation.as_ref())
        {
            self.colors.write(&self.gpu.queue, row_colors);

            let mut buffers = SceneBuffers::new(
                &self.gpu.device,
                &self.gpu.queue,
                &pack.row_infos as &[RowInfo],
                &pack.x0_pool,
                &pack.x1_pool,
            );
            buffers.set_row_layout(&self.gpu.queue, layout);
            buffers.set_row_flags(&self.gpu.queue, hidden, selected);

            self.pipe_single = Some(self.digital.bind(
                &self.gpu,
                Variant::Single,
                &pack.single as &[PackedSegment],
                &self.viewport,
                &self.colors,
                &buffers,
            ));
            self.pipe_multi = Some(self.digital.bind(
                &self.gpu,
                Variant::Multi,
                &pack.multi as &[PackedSegment],
                &self.viewport,
                &self.colors,
                &buffers,
            ));
            self.buffers = Some(buffers);
        }

        if let Some(geom) = snap.result.geometry.as_ref() {
            self.upload_geometry(geom);
        }
    }

    fn upload_geometry(&mut self, geom: &FrameGeometry) {
        let q = &self.gpu.queue;
        self.line_bg.set_lines(q, &geom.lines_bg);
        self.rect_bg.set_rects(q, &geom.rects_bg);
        self.text_body.set_glyphs(q, &geom.glyphs);
        self.line_fg.set_lines(q, &geom.lines_fg);
        self.pill_rect.set_rects(q, &geom.pill_rects);
        self.pill_text.set_glyphs(q, &geom.pill_glyphs);
        self.pill_ranges = geom.pill_ranges.clone();
    }

    fn render(&self, view: &wgpu::TextureView) {
        let mut digital: Vec<&SignalPipeline> = Vec::new();
        if let Some(p) = self.pipe_single.as_ref() {
            digital.push(p);
        }
        if let Some(p) = self.pipe_multi.as_ref() {
            digital.push(p);
        }
        let layers = FrameLayers {
            lines_bg: &self.line_bg,
            rects_bg: &self.rect_bg,
            digital: &digital,
            labels: None,        // deferred (see module docs)
            labels_single: None, // deferred
            text_body: &self.text_body,
            lines_fg: &self.line_fg,
            pill_rects: &self.pill_rect,
            pill_text: &self.pill_text,
            pill_ranges: &self.pill_ranges,
        };
        render_frame(&self.gpu, view, &layers, None);
    }
}
