//! Document/input/trace commands. Bodies OWNED BY UNIT U10 (they route into
//! the seed-frozen `Engine` API and the event channel; Engine internals are
//! wired at integration, U15).

use riptide_contract::doc::DocSync;
use riptide_contract::hier::HierarchyDto;
use riptide_contract::ipc::{BootInfo, InputEvent, TraceSummary, UiEvent};
use tauri::State;
use tauri::ipc::Channel;

use crate::state::AppState;

/// Opens a VCD: with `path` = None shows the native file dialog. Returns None
/// on dialog cancel. Replaces Electron's `riptide:open-vcd` + the addon's
/// `loadVcd`.
#[tauri::command]
pub fn open_vcd(
    _app: tauri::AppHandle,
    _state: State<'_, AppState>,
    _path: Option<String>,
) -> Result<Option<TraceSummary>, String> {
    Err("unimplemented (U10)".into())
}

#[tauri::command]
pub fn get_hierarchy(_state: State<'_, AppState>) -> Result<HierarchyDto, String> {
    Err("unimplemented (U10)".into())
}

/// Boot parameters (CLI arg / env), replacing the `?vcd=` URL param.
#[tauri::command]
pub fn boot_info(_state: State<'_, AppState>) -> BootInfo {
    BootInfo::default()
}

/// Full document mirror from the JS store (see `DocSync` docs for the
/// echo-suppression protocol).
#[tauri::command]
pub fn sync_doc(state: State<'_, AppState>, doc: DocSync) -> Result<(), String> {
    let events = state.engine.lock().expect("engine lock").sync_doc(doc);
    state.emit_all(events);
    Ok(())
}

/// Hot path: raw canvas input at event rate.
#[tauri::command]
pub fn input(state: State<'_, AppState>, ev: InputEvent) -> Result<(), String> {
    let events = state.engine.lock().expect("engine lock").on_input(ev);
    state.emit_all(events);
    Ok(())
}

/// Canvas-region resize (CSS px + device pixel ratio) from the JS
/// ResizeObserver; drives surface reconfigure + viewport width.
#[tauri::command]
pub fn resize(
    state: State<'_, AppState>,
    width: f32,
    height: f32,
    dpr: f32,
) -> Result<(), String> {
    state.engine.lock().expect("engine lock").resize(width, height, dpr);
    Ok(())
}

/// Hands Rust the one Rust→JS event channel.
#[tauri::command]
pub fn subscribe_events(state: State<'_, AppState>, channel: Channel<UiEvent>) {
    *state.events.lock().expect("events lock") = Some(channel);
}

/// Perf HUD control (enable/disable emission, force a render, reset counters).
#[tauri::command]
pub fn perf_control(
    _state: State<'_, AppState>,
    _enable: Option<bool>,
    _reset: Option<bool>,
) -> Result<(), String> {
    // U14: flip the sampler.
    Ok(())
}
