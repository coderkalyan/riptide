//! Document/input/trace commands. Bodies OWNED BY UNIT U10 (they route into
//! the seed-frozen `Engine` API and the event channel; Engine internals are
//! wired at integration, U15).
//!
//! Command bodies are thin shims over plain functions taking `&AppState` so
//! the logic is unit-testable without a running Tauri app.

use riptide_contract::doc::DocSync;
use riptide_contract::hier::HierarchyDto;
use riptide_contract::ipc::{BootInfo, InputEvent, TraceSummary, UiEvent};
use riptide_contract::spec::{ClockGrid, ClockPolarity};
use riptide_core::engine::Engine;
use tauri::State;
use tauri::ipc::Channel;
use tauri_plugin_dialog::DialogExt;

use crate::render_loop::RenderHandle;
use crate::state::AppState;

/// Opens a VCD: with `path` = None shows the native file dialog. Returns None
/// on dialog cancel. Replaces Electron's `riptide:open-vcd` + the addon's
/// `loadVcd`.
///
/// Async so the blocking dialog runs on the async-runtime pool, not the main
/// (event-loop) thread.
#[tauri::command]
pub async fn open_vcd(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    redraw: State<'_, RenderHandle>,
    path: Option<String>,
) -> Result<Option<TraceSummary>, String> {
    let path = match path {
        Some(p) => p,
        None => match pick_vcd(&app) {
            Some(p) => p,
            None => return Ok(None), // dialog cancelled
        },
    };
    let summary = open_vcd_at(&state, &path)?;
    redraw.request_redraw(); // draw the freshly-loaded trace
    Ok(Some(summary))
}

/// Native file dialog filtered to `*.vcd`; None on cancel.
fn pick_vcd(app: &tauri::AppHandle) -> Option<String> {
    let picked = app
        .dialog()
        .file()
        .add_filter("VCD traces", &["vcd"])
        .blocking_pick_file()?;
    let path = picked.into_path().ok()?;
    Some(path.to_string_lossy().into_owned())
}

/// Loads the trace and pushes `TraceLoaded` over the event channel. On a bad
/// open the prior trace stays intact (`Engine::load_trace` only swaps on
/// success), matching the old addon's behavior.
fn open_vcd_at(state: &AppState, path: &str) -> Result<TraceSummary, String> {
    let summary = state
        .engine
        .lock()
        .expect("engine lock")
        .load_trace(path)
        .map_err(|e| e.to_string())?;
    state.emit_all(vec![UiEvent::TraceLoaded { summary: summary.clone() }]);
    Ok(summary)
}

#[tauri::command]
pub fn get_hierarchy(state: State<'_, AppState>) -> Result<HierarchyDto, String> {
    hierarchy_of(&state)
}

fn hierarchy_of(state: &AppState) -> Result<HierarchyDto, String> {
    let engine = state.engine.lock().expect("engine lock");
    let trace = engine.trace.as_ref().ok_or_else(|| "no trace loaded".to_string())?;
    Ok(trace.hierarchy_dto())
}

/// Boot parameters (CLI arg / env), replacing the `?vcd=` URL param.
#[tauri::command]
pub fn boot_info() -> BootInfo {
    boot_info_from(std::env::args(), std::env::var("RIPTIDE_PERF").ok())
}

/// Pure body: first positional CLI arg (skipping argv[0] and `-`-flags) is
/// the trace path; the sidecar sits next to it (`<trace>.sidecar.json`, see
/// CLAUDE.md); `RIPTIDE_PERF` set to anything but ""/"0" enables the perf
/// HUD (the old `?perf=1`).
fn boot_info_from(args: impl IntoIterator<Item = String>, perf_env: Option<String>) -> BootInfo {
    let vcd_path = args.into_iter().skip(1).find(|a| !a.starts_with('-'));
    let sidecar_path = vcd_path.as_ref().map(|p| format!("{p}.sidecar.json"));
    let perf = perf_env.is_some_and(|v| !v.is_empty() && v != "0");
    BootInfo { vcd_path, sidecar_path, perf }
}

/// Full document mirror from the JS store (see `DocSync` docs for the
/// echo-suppression protocol).
#[tauri::command]
pub fn sync_doc(
    state: State<'_, AppState>,
    redraw: State<'_, RenderHandle>,
    doc: DocSync,
) -> Result<(), String> {
    let events = sync_doc_impl(&state, doc);
    state.emit_all(events);
    redraw.request_redraw();
    Ok(())
}

/// Applies the sync, then — if it changed the timebase (clock path or manual
/// override) — re-resolves the clock grid and appends `ClockGridChanged`.
fn sync_doc_impl(state: &AppState, doc: DocSync) -> Vec<UiEvent> {
    let mut engine = state.engine.lock().expect("engine lock");
    let prev_clock = engine.doc.timebase_clock.clone();
    let prev_override = engine.doc.timebase_override;
    let mut events = engine.sync_doc(doc);
    if engine.doc.timebase_clock != prev_clock || engine.doc.timebase_override != prev_override {
        let grid = resolve_clock_grid(&mut engine);
        engine.set_clock_grid(grid); // the engine uses it for geometry + snapping
        events.push(UiEvent::ClockGridChanged { grid });
    }
    events
}

/// The current doc's clock grid (port of the store's `computeTimebase`): a
/// manual override wins; otherwise detect from the clock signal's edge
/// prefix, with the polarity of the matching active row (default rising).
/// None when no timebase clock is set or the path doesn't resolve.
fn resolve_clock_grid(engine: &mut Engine) -> Option<ClockGrid> {
    let doc = &engine.doc;
    let path = doc.timebase_clock.as_deref()?;
    if let Some(ov) = doc.timebase_override {
        return Some(ClockGrid { period: ov.period, phase: ov.phase, valid: true });
    }
    let polarity = doc
        .rows
        .iter()
        .find(|r| r.path == path)
        .map(|r| r.polarity)
        .unwrap_or(ClockPolarity::Rising);
    let trace = engine.trace.as_mut()?;
    let id = trace.find(path)?;
    riptide_core::clock::detect_clock_grid(trace, id, polarity)
}

/// Hot path: raw canvas input at event rate. Drives the engine, emits the
/// resulting events, then wakes the render thread to draw the response.
#[tauri::command]
pub fn input(
    state: State<'_, AppState>,
    redraw: State<'_, RenderHandle>,
    ev: InputEvent,
) -> Result<(), String> {
    let events = state
        .engine
        .lock()
        .expect("engine lock")
        .on_input(ev, crate::state::now_ms());
    state.emit_all(events);
    redraw.request_redraw();
    Ok(())
}

/// Canvas-region resize (CSS px + device pixel ratio) from the JS
/// ResizeObserver; drives surface reconfigure + viewport width.
#[tauri::command]
pub fn resize(
    state: State<'_, AppState>,
    redraw: State<'_, RenderHandle>,
    width: f32,
    height: f32,
    dpr: f32,
) -> Result<(), String> {
    state.engine.lock().expect("engine lock").resize(width, height, dpr);
    redraw.request_redraw();
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

#[cfg(test)]
mod tests {
    use riptide_contract::doc::{DocSync, TimebaseOverride};
    use riptide_contract::ipc::UiEvent;
    use riptide_contract::spec::ClockGrid;

    use super::{boot_info_from, hierarchy_of, open_vcd_at, sync_doc_impl};
    use crate::state::AppState;

    fn args(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| s.to_string()).collect()
    }

    fn mock_vcd() -> String {
        concat!(env!("CARGO_MANIFEST_DIR"), "/../native/src/mock.vcd").to_string()
    }

    // ---- boot_info ----------------------------------------------------

    #[test]
    fn boot_info_first_positional_arg_is_the_trace() {
        let info = boot_info_from(args(&["riptide", "/traces/run1.vcd"]), None);
        assert_eq!(info.vcd_path.as_deref(), Some("/traces/run1.vcd"));
        assert_eq!(info.sidecar_path.as_deref(), Some("/traces/run1.vcd.sidecar.json"));
        assert!(!info.perf);
    }

    #[test]
    fn boot_info_skips_flags_and_argv0() {
        let info = boot_info_from(args(&["riptide", "--foo", "-b", "x.vcd", "y.vcd"]), None);
        assert_eq!(info.vcd_path.as_deref(), Some("x.vcd"));
        assert_eq!(info.sidecar_path.as_deref(), Some("x.vcd.sidecar.json"));
    }

    #[test]
    fn boot_info_empty_when_no_positional_arg() {
        let info = boot_info_from(args(&["riptide", "--flag"]), None);
        assert_eq!(info.vcd_path, None);
        assert_eq!(info.sidecar_path, None);
    }

    #[test]
    fn boot_info_perf_env() {
        assert!(boot_info_from(args(&["r"]), Some("1".into())).perf);
        assert!(boot_info_from(args(&["r"]), Some("inproc".into())).perf);
        assert!(!boot_info_from(args(&["r"]), Some("0".into())).perf);
        assert!(!boot_info_from(args(&["r"]), Some(String::new())).perf);
        assert!(!boot_info_from(args(&["r"]), None).perf);
    }

    // ---- open_vcd / get_hierarchy --------------------------------------

    #[test]
    fn get_hierarchy_errors_without_a_trace() {
        let state = AppState::default();
        assert!(hierarchy_of(&state).is_err());
    }

    #[test]
    fn open_vcd_loads_trace_and_hierarchy_resolves() {
        let state = AppState::default();
        let summary = open_vcd_at(&state, &mock_vcd()).expect("mock opens");
        assert_eq!(summary.end_ticks, 90.0);
        let ts = summary.timescale.expect("mock has $timescale");
        assert_eq!((ts.value, ts.unit.as_str()), (1, "ns"));

        let dto = hierarchy_of(&state).expect("trace is loaded now");
        assert!(!dto.nodes.is_empty());
    }

    #[test]
    fn open_vcd_bad_path_errors_and_keeps_prior_trace() {
        let state = AppState::default();
        open_vcd_at(&state, &mock_vcd()).expect("mock opens");
        assert!(open_vcd_at(&state, "/nonexistent/nope.vcd").is_err());
        assert!(hierarchy_of(&state).is_ok(), "prior trace intact");
    }

    // ---- sync_doc clock-grid emission -----------------------------------

    fn doc(generation: u64) -> DocSync {
        DocSync { generation, ..DocSync::default() }
    }

    #[test]
    fn sync_doc_without_timebase_change_emits_nothing() {
        let state = AppState::default();
        assert!(sync_doc_impl(&state, doc(1)).is_empty());
        assert!(sync_doc_impl(&state, doc(2)).is_empty());
    }

    #[test]
    fn sync_doc_timebase_override_emits_its_grid() {
        let state = AppState::default();
        let mut d = doc(1);
        d.timebase_clock = Some("top.clk".into());
        d.timebase_override = Some(TimebaseOverride { period: 10.0, phase: 5.0 });
        let events = sync_doc_impl(&state, d.clone());
        assert_eq!(
            events,
            vec![UiEvent::ClockGridChanged {
                grid: Some(ClockGrid { period: 10.0, phase: 5.0, valid: true })
            }]
        );

        // Same timebase again → no re-emission.
        d.generation = 2;
        assert!(sync_doc_impl(&state, d).is_empty());
    }

    #[test]
    fn sync_doc_clock_without_trace_emits_none_grid() {
        let state = AppState::default();
        let mut d = doc(1);
        d.timebase_clock = Some("top.clk".into());
        let events = sync_doc_impl(&state, d);
        assert_eq!(events, vec![UiEvent::ClockGridChanged { grid: None }]);
    }

    #[test]
    fn sync_doc_clearing_the_clock_emits_none_grid() {
        let state = AppState::default();
        let mut d = doc(1);
        d.timebase_override = Some(TimebaseOverride { period: 10.0, phase: 5.0 });
        d.timebase_clock = Some("top.clk".into());
        sync_doc_impl(&state, d);

        let events = sync_doc_impl(&state, doc(2));
        assert_eq!(events, vec![UiEvent::ClockGridChanged { grid: None }]);
    }

    #[test]
    fn sync_doc_stale_generation_is_dropped_without_events() {
        let state = AppState::default();
        sync_doc_impl(&state, doc(5));
        let mut stale = doc(3);
        stale.timebase_clock = Some("top.clk".into());
        assert!(sync_doc_impl(&state, stale).is_empty());
    }
}
