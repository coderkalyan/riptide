//! Packing outputs — the Rust port of `native.ts NativeMockSegments` (what the
//! old Zig `getMockSegments` returned) and the pack-cache key.

use serde::{Deserialize, Serialize};

use crate::gpu::{PackedSegment, RowInfo};
use crate::spec::{ClockPolarity, EnumEntry, PackKind, Radix, RowSpec};

/// One packed scene: everything the GPU layer needs to (re)build its segment /
/// row-info / sample-pool buffers, plus the natively formatted value labels.
/// Label *i* of a stream = `bytes[offsets[i]..offsets[i+1]]`; the offsets vec
/// holds `count+1` prefix offsets (so it is `[0]` when the stream is empty).
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PackOutput {
    pub multi: Vec<PackedSegment>,
    pub single: Vec<PackedSegment>,
    pub row_infos: Vec<RowInfo>,
    /// Shared byte-stride sample pools (LSB / MSB planes), each padded to a
    /// 4-byte multiple (bound as array<u32> on the GPU).
    pub x0_pool: Vec<u8>,
    pub x1_pool: Vec<u8>,
    pub multi_label_bytes: Vec<u8>,
    pub multi_label_offsets: Vec<u32>,
    pub single_label_bytes: Vec<u8>,
    pub single_label_offsets: Vec<u32>,
    /// The trace's true end tick.
    pub end_ticks: u64,
}

/// Pack-cache key: everything that affects a signal's packed form EXCEPT its
/// row placement (the row is OR'd in at assembly). Mirrors the Zig `PackKey`.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub struct PackKey {
    pub handle: String,
    pub kind: PackKind,
    pub polarity: ClockPolarity,
    pub shaded: bool,
    pub mute_handle: Option<String>,
    pub radix: Radix,
    pub enums: Vec<EnumEntry>,
}

impl PackKey {
    pub fn of(spec: &RowSpec) -> Self {
        Self {
            handle: spec.handle.clone(),
            kind: spec.kind,
            polarity: spec.polarity,
            shaded: spec.shaded,
            mute_handle: spec.mute_handle.clone(),
            radix: spec.radix,
            enums: spec.enums.clone(),
        }
    }
}
