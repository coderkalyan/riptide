//! The Tauri IPC schema: JS→Rust input events (hot path) and Rust→JS UI
//! events (one `tauri::ipc::Channel<UiEvent>`). Mirrored in
//! `src/renderer/ipc/types.ts`.

use serde::{Deserialize, Serialize};

use crate::hier::TimescaleDto;
use crate::spec::ClockGrid;

/// Raw canvas-region input forwarded from JS at event rate. Coordinates are
/// CSS px relative to the wave-canvas region's top-left.
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum InputEvent {
    #[serde(rename_all = "camelCase")]
    PointerDown { x: f32, y: f32, button: i16, buttons: u16, ctrl: bool, shift: bool },
    #[serde(rename_all = "camelCase")]
    PointerMove { x: f32, y: f32, buttons: u16 },
    #[serde(rename_all = "camelCase")]
    PointerUp { x: f32, y: f32, button: i16, buttons: u16 },
    PointerLeave,
    #[serde(rename_all = "camelCase")]
    Wheel { x: f32, y: f32, dx: f32, dy: f32, ctrl: bool, shift: bool },
    #[serde(rename_all = "camelCase")]
    Key { code: KeyCode, ctrl: bool, shift: bool, alt: bool },
}

/// The canvas-relevant key set (everything else stays a DOM concern in JS).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum KeyCode {
    AddMarker,
    PrevMarker,
    NextMarker,
    DeleteMarker,
    ZoomIn,
    ZoomOut,
    ZoomFit,
    UndoView,
}

/// Per-row derived value text (the active-signals value column).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RowValue {
    pub row: u32,
    pub text: String,
}

/// Boot parameters (replaces the Electron `?vcd=`/`?sidecar=` URL params read
/// by `runtime.ts`; sourced from CLI args / env on the Rust side).
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BootInfo {
    pub vcd_path: Option<String>,
    pub sidecar_path: Option<String>,
    pub perf: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TraceSummary {
    pub path: String,
    pub end_ticks: f64,
    pub timescale: Option<TimescaleDto>,
    pub diagnostics: Vec<String>,
}

/// Perf HUD sample, throttled (~4 Hz) and only emitted while the HUD is on.
#[derive(Clone, Copy, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PerfSample {
    pub fps: f32,
    pub cpu_encode_ms: f32,
    /// None when timestamp-query is unsupported.
    pub gpu_pass_ms: Option<f32>,
    pub pack_ms: f32,
    pub geometry_ms: f32,
    pub frame_count: u64,
}

/// Rust→JS events. Hot ones (`ViewportChanged`, `HoverChanged`, `CursorMoved`,
/// `MarkerMoved`) fire at frame/drag rate, coalesced per frame.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum UiEvent {
    /// Per frame while the view moves; `settled` once on gesture/animation end
    /// (JS maps it to `setViewRange` + `bumpViewSave`).
    #[serde(rename_all = "camelCase")]
    ViewportChanged { start: f64, end: f64, settled: bool },
    #[serde(rename_all = "camelCase")]
    HoverChanged { tick: f64, row: i32, time_label: String, value_text: String },
    HoverCleared,
    /// Cursor placed/dragged on the canvas (authoritative in Rust), with the
    /// formatted per-row value column.
    #[serde(rename_all = "camelCase")]
    CursorMoved { tick: f64, label: String, row_values: Vec<RowValue> },
    #[serde(rename_all = "camelCase")]
    MarkerMoved { id: u32, tick: f64 },
    #[serde(rename_all = "camelCase")]
    MarkerSelected { id: Option<u32> },
    #[serde(rename_all = "camelCase")]
    ClockGridChanged { grid: Option<ClockGrid> },
    #[serde(rename_all = "camelCase")]
    TraceLoaded { summary: TraceSummary },
    #[serde(rename_all = "camelCase")]
    Perf { sample: PerfSample },
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn input_event_wire_shape() {
        let ev = InputEvent::Wheel { x: 1.0, y: 2.0, dx: 0.0, dy: -120.0, ctrl: true, shift: false };
        let json = serde_json::to_string(&ev).unwrap();
        assert_eq!(
            json,
            r#"{"type":"wheel","x":1.0,"y":2.0,"dx":0.0,"dy":-120.0,"ctrl":true,"shift":false}"#
        );
    }
}
