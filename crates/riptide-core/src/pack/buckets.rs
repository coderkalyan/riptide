//! Downsampled (bucket) packing — the NEW zoomed-out render path on tide.rs
//! `query_buckets`. Quiet bucket runs (0 transitions) carry the prior value and
//! emit ordinary `PackedSegment`s; busy runs (≥1 transition per bucket)
//! coalesce into `BucketBand`s drawn via the rect batch (no WGSL change).
//!
//! OWNED BY UNIT U9.

use riptide_contract::geometry::BucketBand;
use riptide_contract::gpu::PackedSegment;
use riptide_contract::spec::RowSpec;

use crate::{Error, TraceDb};

/// Transition budget per canvas: above ~4× the canvas width in estimated
/// in-window transitions a row switches to bucket mode (with ±2× hysteresis so
/// zooming across the boundary doesn't flap modes).
pub const BUCKET_BUDGET_PER_PX: f64 = 4.0;

/// Mode policy: should `row` pack via buckets this frame?
pub fn should_bucket(estimated_transitions: u64, canvas_px: f32, currently_bucketed: bool) -> bool {
    let budget = BUCKET_BUDGET_PER_PX * canvas_px as f64;
    let n = estimated_transitions as f64;
    if currently_bucketed { n > budget / 2.0 } else { n > budget * 2.0 }
}

/// One row's bucket-mode pack: segments for the quiet runs (plus their sample
/// bytes/labels, same layout as the normal path) and bands for the busy runs.
#[derive(Clone, Debug, Default)]
pub struct RowBucketPack {
    pub segments: Vec<PackedSegment>,
    pub x0: Vec<u8>,
    pub x1: Vec<u8>,
    pub label_bytes: Vec<u8>,
    pub label_offsets: Vec<u32>,
    pub bands: Vec<BucketBand>,
}

/// Packs one row over `[q_start, q_end]` at `period` ticks per bucket
/// (`period ≈ ticks_per_pixel`, min 1).
pub fn pack_row_buckets(
    _db: &mut TraceDb,
    _spec: &RowSpec,
    _q_start: u64,
    _q_end: u64,
    _period: u64,
) -> Result<RowBucketPack, Error> {
    todo!("U9: bucket walk — quiet runs → segments, busy runs → bands")
}
