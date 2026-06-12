//! Rust→JS event plumbing helpers (the channel itself lives in
//! `state::AppState`). OWNED BY UNIT U10.
//!
//! Hot events fire at frame/drag rate; the render loop pushes them into the
//! [`Coalescer`] as the engine produces them and calls [`flush`] once per
//! frame, so JS sees at most one of each hot kind (per id, where there is
//! one) per frame. Cold events pass through untouched, in arrival order.

// The coalescer is consumed by the render loop, wired at U15 integration; until
// then it is constructed but not driven, so silence the dead-code lints.
#![allow(dead_code)]

use riptide_contract::ipc::UiEvent;

use crate::state::AppState;

/// Per-frame coalescer for the hot `UiEvent`s.
///
/// Rules (latest wins in every slot):
/// - `ViewportChanged`: keep only the latest.
/// - `HoverChanged` / `HoverCleared`: one shared slot — the latest hover
///   state is the only one worth showing (a clear after a change must not
///   resurrect the stale hover, and vice versa).
/// - `CursorMoved`: keep only the latest (there is one cursor).
/// - `MarkerMoved`: latest per marker id (first-seen id order preserved).
/// - Everything else is cold: queued verbatim, emitted in order.
///
/// `drain` emits cold events first (they describe discrete state changes the
/// hot deltas build on — e.g. `TraceLoaded` before the first
/// `ViewportChanged`), then viewport, hover, cursor, markers.
#[derive(Default)]
pub struct Coalescer {
    cold: Vec<UiEvent>,
    viewport: Option<UiEvent>,
    hover: Option<UiEvent>,
    cursor: Option<UiEvent>,
    markers: Vec<UiEvent>,
}

impl Coalescer {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn push(&mut self, ev: UiEvent) {
        match ev {
            UiEvent::ViewportChanged { .. } => self.viewport = Some(ev),
            UiEvent::HoverChanged { .. } | UiEvent::HoverCleared => self.hover = Some(ev),
            UiEvent::CursorMoved { .. } => self.cursor = Some(ev),
            UiEvent::MarkerMoved { id, .. } => {
                let slot = self.markers.iter_mut().find(
                    |m| matches!(m, UiEvent::MarkerMoved { id: prev, .. } if *prev == id),
                );
                match slot {
                    Some(prev) => *prev = ev,
                    None => self.markers.push(ev),
                }
            }
            cold => self.cold.push(cold),
        }
    }

    pub fn extend(&mut self, events: impl IntoIterator<Item = UiEvent>) {
        for ev in events {
            self.push(ev);
        }
    }

    pub fn is_empty(&self) -> bool {
        self.cold.is_empty()
            && self.viewport.is_none()
            && self.hover.is_none()
            && self.cursor.is_none()
            && self.markers.is_empty()
    }

    /// Takes everything accumulated since the last drain, in emission order.
    pub fn drain(&mut self) -> Vec<UiEvent> {
        let mut out = std::mem::take(&mut self.cold);
        out.extend(self.viewport.take());
        out.extend(self.hover.take());
        out.extend(self.cursor.take());
        out.append(&mut self.markers);
        out
    }
}

/// Once-per-frame send: drains the state's coalescer into the JS event
/// channel. Called by the render loop after `Engine::frame`.
pub fn flush(state: &AppState) {
    let events = state.coalescer.lock().expect("coalescer lock").drain();
    state.emit_all(events);
}

#[cfg(test)]
mod tests {
    use riptide_contract::ipc::{TraceSummary, UiEvent};

    use super::Coalescer;

    fn viewport(start: f64, settled: bool) -> UiEvent {
        UiEvent::ViewportChanged { start, end: start + 100.0, settled }
    }

    fn hover(tick: f64) -> UiEvent {
        UiEvent::HoverChanged {
            tick,
            row: 0,
            time_label: format!("{tick}"),
            value_text: String::new(),
        }
    }

    fn cursor(tick: f64) -> UiEvent {
        UiEvent::CursorMoved { tick, label: format!("{tick}"), row_values: Vec::new() }
    }

    fn marker(id: u32, tick: f64) -> UiEvent {
        UiEvent::MarkerMoved { id, tick }
    }

    fn trace_loaded(path: &str) -> UiEvent {
        UiEvent::TraceLoaded {
            summary: TraceSummary {
                path: path.to_string(),
                end_ticks: 90.0,
                timescale: None,
                diagnostics: Vec::new(),
            },
        }
    }

    #[test]
    fn keeps_only_latest_viewport_hover_cursor() {
        let mut c = Coalescer::new();
        c.extend([
            viewport(0.0, false),
            hover(1.0),
            viewport(10.0, false),
            cursor(5.0),
            hover(2.0),
            viewport(20.0, true),
            cursor(6.0),
        ]);
        assert_eq!(c.drain(), vec![viewport(20.0, true), hover(2.0), cursor(6.0)]);
    }

    #[test]
    fn hover_cleared_supersedes_hover_changed_and_back() {
        let mut c = Coalescer::new();
        c.push(hover(1.0));
        c.push(UiEvent::HoverCleared);
        assert_eq!(c.drain(), vec![UiEvent::HoverCleared]);

        c.push(UiEvent::HoverCleared);
        c.push(hover(3.0));
        assert_eq!(c.drain(), vec![hover(3.0)]);
    }

    #[test]
    fn markers_coalesce_per_id_keeping_first_seen_order() {
        let mut c = Coalescer::new();
        c.extend([marker(2, 10.0), marker(1, 11.0), marker(2, 12.0), marker(1, 13.0)]);
        assert_eq!(c.drain(), vec![marker(2, 12.0), marker(1, 13.0)]);
    }

    #[test]
    fn cold_events_pass_through_in_order_before_hot() {
        let mut c = Coalescer::new();
        c.extend([
            viewport(1.0, false),
            trace_loaded("a.vcd"),
            UiEvent::MarkerSelected { id: Some(3) },
            viewport(2.0, false),
        ]);
        assert_eq!(
            c.drain(),
            vec![
                trace_loaded("a.vcd"),
                UiEvent::MarkerSelected { id: Some(3) },
                viewport(2.0, false),
            ]
        );
    }

    #[test]
    fn drain_resets_state() {
        let mut c = Coalescer::new();
        assert!(c.is_empty());
        c.push(viewport(1.0, false));
        c.push(marker(1, 2.0));
        assert!(!c.is_empty());
        assert_eq!(c.drain().len(), 2);
        assert!(c.is_empty());
        assert!(c.drain().is_empty());
    }
}
