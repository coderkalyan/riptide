//! File/menu/persistence commands. Bodies OWNED BY UNIT U11 (except
//! `save_canvas`'s render-side internals, which call U12's frozen
//! `riptide_render::capture` API).

use tauri::State;

use crate::state::AppState;

/// Reads the sidecar text next to the trace; Ok(None) when absent.
#[tauri::command]
pub fn read_sidecar(_path: String) -> Result<Option<String>, String> {
    Err("unimplemented (U11)".into())
}

/// Atomic write (tmp + rename) of the sidecar.
#[tauri::command]
pub fn write_sidecar(_path: String, _text: String) -> Result<(), String> {
    Err("unimplemented (U11)".into())
}

/// The recent-traces list (recent.json in the app data dir). Replaces
/// `riptide:recent-vcds`.
#[tauri::command]
pub fn recent_vcds(_app: tauri::AppHandle) -> Result<Vec<String>, String> {
    Err("unimplemented (U11)".into())
}

#[tauri::command]
pub fn add_recent(_app: tauri::AppHandle, _path: String) -> Result<(), String> {
    Err("unimplemented (U11)".into())
}

/// "Export sidecar…" — save dialog + write. Replaces `riptide:export-sidecar`.
#[tauri::command]
pub fn export_sidecar(_app: tauri::AppHandle, _text: String) -> Result<(), String> {
    Err("unimplemented (U11)".into())
}

/// "Save canvas…" — offscreen wgpu render → PNG → save dialog. Replaces
/// `riptide:save-canvas` (capture moves fully to Rust).
#[tauri::command]
pub fn save_canvas(_app: tauri::AppHandle, _state: State<'_, AppState>) -> Result<(), String> {
    Err("unimplemented (U11 + U12 capture)".into())
}

#[tauri::command]
pub fn close_window(window: tauri::Window) -> Result<(), String> {
    window.close().map_err(|e| e.to_string())
}
