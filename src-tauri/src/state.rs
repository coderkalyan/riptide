//! Shared Tauri-managed state.
//!
//! The `Engine` and the Rust→JS event channel are `Arc<Mutex<…>>` so the
//! render thread (spawned in `surface::init`) and the IPC command handlers
//! share them. Commands lock briefly to mutate; the render thread locks once
//! per frame to call `Engine::frame`.

use std::sync::{Arc, Mutex, OnceLock};
use std::time::Instant;

use riptide_contract::ipc::UiEvent;
use riptide_core::engine::Engine;
use tauri::ipc::Channel;

pub type SharedEngine = Arc<Mutex<Engine>>;
pub type SharedEvents = Arc<Mutex<Option<Channel<UiEvent>>>>;

#[derive(Default)]
pub struct AppState {
    pub engine: SharedEngine,
    /// The JS-side event channel, handed over by `subscribe_events`.
    pub events: SharedEvents,
}

impl AppState {
    /// Pushes events to JS if a channel is subscribed (drops them otherwise —
    /// boot races are benign).
    pub fn emit_all(&self, events: Vec<UiEvent>) {
        emit_to(&self.events, events);
    }
}

/// Shared emit used by both the command layer and the render thread.
pub fn emit_to(events: &SharedEvents, msgs: Vec<UiEvent>) {
    if msgs.is_empty() {
        return;
    }
    if let Some(ch) = events.lock().expect("events lock").as_ref() {
        for ev in msgs {
            let _ = ch.send(ev);
        }
    }
}

/// Monotonic milliseconds since first call — the injected clock for the
/// viewport animation / input timestamps (no wall-clock reads in the engine).
pub fn now_ms() -> f64 {
    static START: OnceLock<Instant> = OnceLock::new();
    START.get_or_init(Instant::now).elapsed().as_secs_f64() * 1000.0
}
