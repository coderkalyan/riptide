//! wgpu surface acquisition from the Tauri/tao window (raw-window-handle) and
//! resize/scale-factor reconfiguration. The webview sits transparent on top;
//! wgpu draws to the window surface underneath (official wry wgpu pattern).
//!
//! OWNED BY UNIT U1 (the compositing spike). Findings — threading model,
//! platform quirks, present pacing — go in MIGRATION.md §U1-findings.

use tauri::App;

/// Sets up the wgpu instance/surface/device against the main window and
/// starts the render loop. Seed stub: no-op (the app runs webview-only).
pub fn init(_app: &mut App) -> Result<(), Box<dyn std::error::Error>> {
    // U1: create wgpu::Instance, surface from the window's raw handles,
    // request adapter/device, configure for the window's physical size, then
    // render_loop::start(...).
    Ok(())
}
