//! Signal packing: tide query → GPU-ready `PackOutput`. Port of
//! `native/src/pack.zig` + `segments.zig` (data/clk flag walks, mute-boundary
//! merge, per-signal `PackedSignal` cache keyed by `PackKey`, scene assembly,
//! pool finalize/padding).
//!
//! OWNED BY UNIT U2 (bodies + internals). `buckets` is unit U9.
//!
//! tide.rs deltas vs the Zig port source (see MIGRATION.md):
//! - `SignalQuery` is multiple zero-copy runs (chunks + tail), not one slice:
//!   the old single-memcpy `setSamples` becomes one memcpy per run of the
//!   plane-0/plane-1 columns.
//! - Absent planes read as zero: a 2-state chunk has no p1 plane — materialize
//!   zeros into the x1 pool.
//! - Times are u64; keep the low-32 truncation for GPU `PackedSegment` times
//!   (the viewport's int/frac split handles display precision).

pub mod buckets;

use riptide_contract::pack::{PackKey, PackOutput};
use riptide_contract::spec::RowSpec;

use crate::{Error, TraceDb};

/// The stateful packer: owns the `PackKey → packed signal` cache so an
/// add/remove/reorder/radix-change repacks only the changed signal.
#[derive(Default)]
pub struct Packer {
    _private: (),
}

impl Packer {
    pub fn new() -> Self {
        Self::default()
    }

    /// Packs `specs` over the query window `[q_start, q_end]` (the viewport
    /// plus over-fetch margin), reusing cached per-signal packs where the
    /// `PackKey` and window still match.
    pub fn pack(
        &mut self,
        _db: &mut TraceDb,
        _specs: &[RowSpec],
        _q_start: u64,
        _q_end: u64,
    ) -> Result<PackOutput, Error> {
        todo!("U2: port pack.zig packSignal + segments.zig Scene/finalize")
    }

    /// Drops every cached pack (call on trace swap — handles invalidate).
    pub fn clear(&mut self) {}

    /// Whether a cached pack exists for this key over this window (used by
    /// `sync_doc` diffing to decide if a repack is needed).
    pub fn contains(&self, _key: &PackKey, _q_start: u64, _q_end: u64) -> bool {
        false
    }
}
