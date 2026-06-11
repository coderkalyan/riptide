//! The Tauri app shell. Every IPC command is registered HERE (and only here)
//! with its body in `commands_doc.rs` / `commands_files.rs` — work units never
//! touch this registration list, so unit branches don't conflict on it.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod commands_doc;
mod commands_files;
mod events;
mod perf;
mod render_loop;
mod state;
mod surface;

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(state::AppState::default())
        .setup(|app| {
            surface::init(app)?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands_doc::open_vcd,
            commands_doc::get_hierarchy,
            commands_doc::boot_info,
            commands_doc::sync_doc,
            commands_doc::input,
            commands_doc::resize,
            commands_doc::subscribe_events,
            commands_doc::perf_control,
            commands_files::read_sidecar,
            commands_files::write_sidecar,
            commands_files::recent_vcds,
            commands_files::add_recent,
            commands_files::export_sidecar,
            commands_files::save_canvas,
            commands_files::close_window,
        ])
        .run(tauri::generate_context!())
        .expect("error while running riptide");
}
