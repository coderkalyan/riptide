//! Value → label formatting. The SINGLE implementation replacing the old
//! dual-impl sync between `native/src/label.zig` and
//! `src/renderer/wave/value.ts`.
//!
//! OWNED BY UNIT U3. Plane convention: tide.rs — a bit is unknown when its p1
//! bit is set; among unknowns, p0=1 → X, p0=0 → Z (NOT the Zig convention; see
//! `trace.rs` module docs). The hex nibble grouping must stay bug-compatible
//! with label.zig (MSB-grouping quirk on non-nibble-aligned widths) so
//! differential label tests stay byte-equal.

use riptide_contract::spec::{EnumEntry, Radix};

/// Appends the formatted label of one sample to `out` (ASCII). `x0`/`x1` are
/// the sample's little-endian byte planes ((p0, p1) in tide.rs terms),
/// `bytes_per_sample = ceil(width/8)` bytes each.
///
/// Seed stub: writes `"?"` (non-panicking so pack-unit differential tests can
/// run structurally before U3 merges; they skip label-byte assertions).
pub fn format_value(
    out: &mut Vec<u8>,
    _x0: &[u8],
    _x1: &[u8],
    _width: u32,
    _radix: Radix,
    _enums: &[EnumEntry],
) {
    out.push(b'?');
}

/// The readout-flavored formatter (cursor value column / hover) — same digits
/// as `format_value` but with the `wave/value.ts formatSegmentValue` prefixes.
///
/// Seed stub: returns `"?"`.
pub fn format_segment_value(
    _x0: &[u8],
    _x1: &[u8],
    _width: u32,
    _radix: Radix,
    _enums: &[EnumEntry],
) -> String {
    "?".to_string()
}
