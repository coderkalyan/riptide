//! wgpu surface acquisition from the Tauri/tao window (raw-window-handle) and
//! resize/scale-factor reconfiguration. The webview sits transparent on top;
//! wgpu draws to the window surface underneath (official wry wgpu pattern).
//!
//! OWNED BY UNIT U1 (the compositing spike). Findings — threading model,
//! platform quirks, present pacing — in MIGRATION.md §U1 findings.
//!
//! Threading model (see §U1 findings for the full rationale): everything GTK
//! happens on the main thread inside the setup hook — window lookup, raw
//! handle access, surface creation. The resulting `GfxState` is then handed to
//! a dedicated render thread (`render_loop::start`); wgpu objects are
//! `Send + Sync`, and the render thread never touches GTK again. Resize /
//! scale-factor / destroy events arrive on `window.on_window_event` and are
//! forwarded to the render thread through its `RenderHandle` (we do not own
//! `Builder::run`'s event callback — main.rs is frozen — and tao's GTK loop
//! must never block on vsync anyway).

use std::error::Error;
use std::sync::{Arc, Mutex};

use tauri::{App, Manager, WindowEvent};

use crate::render_loop;

/// Everything the render loop needs to present to the window. Built once on
/// the main thread; afterwards owned by the render thread (`config` is behind
/// a mutex only because resize requests mutate it from that same thread while
/// the handle API stays `&self`).
pub struct GfxState {
    pub surface: wgpu::Surface<'static>,
    pub device: wgpu::Device,
    pub queue: wgpu::Queue,
    pub config: Mutex<wgpu::SurfaceConfiguration>,
}

impl GfxState {
    /// Reconfigures the surface at a new physical size (resize / DPR change).
    pub fn reconfigure(&self, width: u32, height: u32) {
        let mut config = self.config.lock().expect("surface config lock");
        config.width = width.max(1);
        config.height = height.max(1);
        self.surface.configure(&self.device, &config);
    }

    /// Re-applies the current configuration (swapchain Lost/Outdated).
    pub fn reconfigure_current(&self) {
        let config = self.config.lock().expect("surface config lock");
        self.surface.configure(&self.device, &config);
    }

    pub fn format(&self) -> wgpu::TextureFormat {
        self.config.lock().expect("surface config lock").format
    }
}

/// Sets up the wgpu instance/surface/device against the main window and
/// starts the render loop. Must run on the main thread (GTK handle access).
pub fn init(app: &mut App) -> Result<(), Box<dyn Error>> {
    let window = app
        .get_webview_window("main")
        .ok_or("main window missing")?;
    let size = window.inner_size()?;
    let scale = window.scale_factor().unwrap_or(1.0);

    let instance = wgpu::Instance::default();
    // tauri::WebviewWindow implements HasWindowHandle/HasDisplayHandle and is
    // Send + Sync + 'static, so an owned clone backs a Surface<'static>. On
    // Linux the handle comes from the GTK window: Xlib under X11/XWayland,
    // the gdk wl_surface under native Wayland. Native Wayland is NOT viable
    // for this pattern (GTK and wgpu would both attach buffers to the same
    // wl_surface) — run with GDK_BACKEND=x11; see MIGRATION.md §U1 findings.
    let surface = instance.create_surface(window.clone())?;
    let adapter = pollster::block_on(instance.request_adapter(&wgpu::RequestAdapterOptions {
        power_preference: wgpu::PowerPreference::default(),
        force_fallback_adapter: false,
        compatible_surface: Some(&surface),
    }))?;
    let (device, queue) = pollster::block_on(adapter.request_device(&wgpu::DeviceDescriptor {
        label: Some("riptide-device"),
        ..Default::default()
    }))?;

    let caps = surface.get_capabilities(&adapter);
    // Prefer a non-sRGB format: the JS renderer wrote raw bytes to a
    // bgra8unorm canvas, so palette parity wants no implicit sRGB encode.
    let format = caps
        .formats
        .iter()
        .copied()
        .find(|f| !f.is_srgb())
        .unwrap_or(caps.formats[0]);
    let config = wgpu::SurfaceConfiguration {
        usage: wgpu::TextureUsages::RENDER_ATTACHMENT,
        format,
        width: size.width.max(1),
        height: size.height.max(1),
        // Fifo = vsync, universally supported; combined with the dirty-flag
        // scheme it paces the render thread via swapchain back-pressure.
        present_mode: wgpu::PresentMode::Fifo,
        desired_maximum_frame_latency: 2,
        // The wgpu layer is the opaque bottom of the stack (the webview above
        // is the transparent one), so the default/opaque alpha mode is right.
        alpha_mode: caps.alpha_modes[0],
        view_formats: vec![],
    };
    surface.configure(&device, &config);

    let info = adapter.get_info();
    eprintln!(
        "[riptide-gfx] adapter '{}' backend {:?}, surface {}x{} (scale {scale}), format {format:?}, alpha {:?}",
        info.name, info.backend, config.width, config.height, config.alpha_mode,
    );

    let gfx = Arc::new(GfxState { surface, device, queue, config: Mutex::new(config) });

    // Share the engine + event channel with the render thread (both Arcs in the
    // managed AppState — see state.rs). The render thread locks the engine once
    // per frame; the command handlers lock it briefly to mutate.
    let (engine, events) = {
        let app_state = app.state::<crate::state::AppState>();
        (app_state.engine.clone(), app_state.events.clone())
    };
    let handle = render_loop::start(gfx, engine, events, scale as f32);

    // Resize + scale-factor reconfigure, and render-thread shutdown when the
    // window goes away. Sizes are already physical px (tao reports physical).
    let hook = handle.clone();
    window.on_window_event(move |event| match event {
        WindowEvent::Resized(size) => hook.resize(size.width, size.height),
        WindowEvent::ScaleFactorChanged { new_inner_size, .. } => {
            hook.resize(new_inner_size.width, new_inner_size.height)
        }
        WindowEvent::Destroyed => hook.shutdown(),
        _ => {}
    });

    // Future units (resize command, engine events) poke the loop through this.
    app.manage(handle);
    Ok(())
}
