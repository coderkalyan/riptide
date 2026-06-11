//! Document sync — the JS store's persisted slice mirrored down to Rust.

use serde::{Deserialize, Serialize};

use crate::spec::RowSpec;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MarkerDto {
    pub id: u32,
    pub name: String,
    pub tick: f64,
    pub color: u32,
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TimebaseOverride {
    pub period: f64,
    pub phase: f64,
}

/// Full document mirror, sent on any store mutation that affects Rust-side
/// state (rows, markers, cursor, clock config). Rust diffs `rows` against its
/// pack cache so only changed signals repack.
///
/// Echo-suppression protocol: canvas-originated changes (cursor placement,
/// marker drag) are authoritative in Rust and pushed up as `UiEvent`s; JS
/// applies them under an `applyingRemote` guard so its own store subscription
/// does not sync them back. `generation` increments on every JS-originated
/// sync; Rust drops a `DocSync` whose generation is older than one it has
/// already applied (it raced an in-flight drag).
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DocSync {
    pub rows: Vec<RowSpec>,
    pub markers: Vec<MarkerDto>,
    pub selected_marker: Option<u32>,
    pub cursor: f64,
    pub snap_cursor: bool,
    pub clock_anchor: bool,
    /// Timebase clock by hierarchical path (None = absolute time).
    pub timebase_clock: Option<String>,
    pub timebase_override: Option<TimebaseOverride>,
    pub generation: u64,
}

impl Default for MarkerDto {
    fn default() -> Self {
        Self { id: 0, name: String::new(), tick: 0.0, color: 0 }
    }
}
