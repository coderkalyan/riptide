//! Per-row packing/render specs — the Rust port of `native.ts NativePackSpec`
//! plus the render cosmetics a row carries (color, dim, layout). Sent from JS
//! inside `DocSync`.

use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Radix {
    Bin,
    Hex,
    Dec,
    Sdec,
    Enum,
    Boolean,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PackKind {
    Data,
    Clk,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ClockPolarity {
    Rising,
    Falling,
    Both,
}

/// One enum table entry: integer value (matched against the sample's low word)
/// → display label.
#[derive(Clone, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct EnumEntry {
    pub value: u32,
    pub label: String,
}

/// The detected (or overridden) timebase grid: clock period/phase in ticks.
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
pub struct ClockGrid {
    pub period: f64,
    pub phase: f64,
    pub valid: bool,
}

/// One active row's full spec: what to query/pack/format (the old
/// `NativePackSpec`) plus how to draw it. `handle` is the trace signal id as a
/// decimal string (matches the hierarchy DTO's `handle`).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RowSpec {
    pub row: u32,
    pub handle: String,
    /// Hierarchical dot path — the sidecar-stable identity (not run-specific).
    pub path: String,
    pub kind: PackKind,
    /// Clock rows only: which edges get a chevron (ignored for data).
    pub polarity: ClockPolarity,
    pub shaded: bool,
    /// 1-bit enable handle that mutes this row while it isn't logic-1.
    pub mute_handle: Option<String>,
    pub radix: Radix,
    pub enums: Vec<EnumEntry>,
    /// Packed rgba (0xAABBGGRR, little-endian byte order — see `packRgba`).
    pub color: u32,
    /// Eye toggle (dim), maps to ROW_FLAG_DIM.
    pub hidden: bool,
    /// Row selection, maps to ROW_FLAG_HIGHLIGHT.
    pub selected: bool,
    /// Per-row height override in CSS px (None = default row height).
    pub height: Option<f32>,
    pub divider_below: bool,
    pub divider_height: Option<f32>,
    pub bit_width: u32,
}
