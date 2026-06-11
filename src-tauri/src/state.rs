//! Shared Tauri-managed state.

use std::sync::Mutex;

use riptide_contract::ipc::UiEvent;
use riptide_core::engine::Engine;
use tauri::ipc::Channel;

#[derive(Default)]
pub struct AppState {
    pub engine: Mutex<Engine>,
    /// The JS-side event channel, handed over by `subscribe_events`.
    pub events: Mutex<Option<Channel<UiEvent>>>,
}

impl AppState {
    /// Pushes events to JS if a channel is subscribed (drops them otherwise —
    /// boot races are benign).
    pub fn emit_all(&self, events: Vec<UiEvent>) {
        if events.is_empty() {
            return;
        }
        if let Some(ch) = self.events.lock().expect("events lock").as_ref() {
            for ev in events {
                let _ = ch.send(ev);
            }
        }
    }
}
