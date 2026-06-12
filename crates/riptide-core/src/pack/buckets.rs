//! Downsampled (bucket) packing — the NEW zoomed-out render path on tide.rs
//! `query_buckets`. Quiet bucket runs (0 transitions) carry the prior value and
//! emit ordinary `PackedSegment`s; busy runs (≥1 transition per bucket)
//! coalesce into `BucketBand`s drawn via the rect batch (no WGSL change).
//!
//! OWNED BY UNIT U9.
//!
//! Semantics (documented design choices):
//!
//! - Buckets tile `[q_start + k*period, q_start + (k+1)*period)` on tide's
//!   exact grid anchored at `q_start`; `period` is clamped to ≥ 1. The number
//!   of buckets is `(q_end - q_start) / period + 1` (tide includes the bucket
//!   that holds `q_end`), so the final run's nominal end can overshoot the
//!   window — its `t_end` is clamped to `q_end`. Interior run boundaries fall
//!   on bucket starts, which are always ≤ `q_end`. Bands and segments
//!   therefore partition `[q_start, q_end]` exactly: each run's `t_end` is the
//!   next run's `t_start`, with no gaps or overlaps.
//! - A maximal run of quiet buckets carries the value in effect: from
//!   `BucketQuery::initial()` (the covering sample strictly before the window)
//!   for a leading quiet run, else from the preceding busy run's last bucket's
//!   `last()` value. **A leading quiet run with no known value (`initial()` is
//!   `None`, i.e. the window starts before the signal's first sample) emits
//!   nothing** — neither segment nor band — so the partition starts at the
//!   first busy run's boundary. Consumers render nothing where the signal is
//!   not yet defined (mirrors the normal path, whose first segment starts at
//!   the signal's first in-window sample).
//! - Plane convention is tide.rs: sample plane p0 → `x0`, p1 → `x1`; an absent
//!   plane reads as zeros. One `bytes_per_sample`-byte sample is pushed per
//!   emitted segment.
//! - Flags mirror the normal data walk in `native/src/pack.zig`: row bits are
//!   left 0 (the caller ORs the row in at assembly); `FLAG_SHADE` follows
//!   `spec.shaded` (data rows only); a quiet segment gets `FLAG_RIGHT_EDGE`
//!   when a busy run follows. Multi-pipeline rows (radix not bin/boolean) draw
//!   the right gap unconditionally; single-pipeline rows suppress the edge
//!   when the segment's value or the following bucket touches x/z (the bucket
//!   x/z flag over-approximates the Zig per-sample test — at bucket zoom the
//!   next *sample* isn't individually addressable, and a sub-pixel edge next
//!   to an unknown band is invisible anyway).
//! - Bucket mode draws no clock chevrons (a quiet clock run is constant; busy
//!   runs are bands) and ignores `mute_handle` (the zoomed-out band/segment
//!   picture has no per-sample mute boundaries; mute dimming is an exact-path
//!   feature).
//! - Labels follow the normal path's rule: every emitted segment of a labeled
//!   row (`radix != bin`) formats one label via `format::value::format_value`;
//!   bin rows emit none, leaving `label_offsets == [0]`.
//! - Real-kind signals have no plane bytes to carry: busy runs still produce
//!   bands, quiet runs emit no segments (graceful degradation; reals are not
//!   rendered by the digital pipelines).

use riptide_contract::geometry::BucketBand;
use riptide_contract::gpu::{FLAG_RIGHT_EDGE, FLAG_SHADE, PackedSegment, bytes_per_sample};
use riptide_contract::spec::{PackKind, Radix, RowSpec};
use tide::{LogicSlice, OwnedValue, TimeRange};

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

/// Copies a (possibly absent) plane into an owned `stride`-byte buffer,
/// zero-filling what the source doesn't cover.
fn copy_plane(src: &[u8], stride: usize) -> Vec<u8> {
    let mut out = vec![0u8; stride];
    let n = src.len().min(stride);
    out[..n].copy_from_slice(&src[..n]);
    out
}

/// The (p0, p1) byte pair of one sample, owned, at the row's stride.
fn plane_pair(v: LogicSlice<'_>, stride: usize) -> (Vec<u8>, Vec<u8>) {
    (copy_plane(v.plane(0), stride), copy_plane(v.plane(1), stride))
}

/// Packs one row over `[q_start, q_end]` at `period` ticks per bucket
/// (`period ≈ ticks_per_pixel`, min 1).
pub fn pack_row_buckets(
    db: &mut TraceDb,
    spec: &RowSpec,
    q_start: u64,
    q_end: u64,
    period: u64,
) -> Result<RowBucketPack, Error> {
    let mut pack = RowBucketPack::default();
    pack.label_offsets.push(0);
    // Empty (inverted) window: nothing to pack.
    if q_start > q_end {
        return Ok(pack);
    }
    let period = period.max(1);
    let id = TraceDb::handle(&spec.handle)?;
    let mut results = db.query_buckets(&[id], TimeRange::new(q_start, q_end), period)?;
    // A signal unknown to the database queries as `None` — empty pack.
    let Some(bq) = results.pop().flatten() else {
        return Ok(pack);
    };

    let stride = bytes_per_sample(spec.bit_width) as usize;
    // Pipeline routing is format-driven, like the normal path: bin/boolean
    // rows draw on the single (line) pipeline, the rest on multi (pills).
    let is_multi = !matches!(spec.radix, Radix::Bin | Radix::Boolean);
    let labeled = spec.radix != Radix::Bin;
    let shade = if spec.shaded && spec.kind == PackKind::Data { FLAG_SHADE } else { 0 };

    // The value in effect entering the walk: the covering sample strictly
    // before the window (None at q_start == 0, before the signal's first
    // sample, or for real signals).
    let mut cur: Option<(Vec<u8>, Vec<u8>)> = match bq.initial().map(|s| &s.value) {
        Some(OwnedValue::Logic(buf)) => Some(plane_pair(buf.as_slice(), stride)),
        _ => None,
    };

    let len = bq.len();
    let mut i = 0usize;
    while i < len {
        // Extend the maximal run of same-kind buckets, OR-folding x/z flags
        // (quiet buckets carry no flags, so folding them is harmless).
        let busy = bq.bucket(i).transitions() > 0;
        let mut has_x = bq.bucket(i).has_x();
        let mut has_z = bq.bucket(i).has_z();
        let mut j = i + 1;
        while j < len && (bq.bucket(j).transitions() > 0) == busy {
            has_x |= bq.bucket(j).has_x();
            has_z |= bq.bucket(j).has_z();
            j += 1;
        }
        let t0 = q_start + i as u64 * period;
        let t1 = if j == len { q_end } else { q_start + j as u64 * period };

        if busy {
            pack.bands.push(BucketBand {
                row: spec.row,
                t_start: t0,
                t_end: t1,
                has_x,
                has_z,
                multi: spec.bit_width > 1,
            });
            // The value carried into the next quiet run: after the last
            // change of this run's last bucket (count ≥ 1, so `last()` is
            // `Some` for logic signals; `None` for reals — `cur` stays unset).
            if let Some(last) = bq.bucket(j - 1).last() {
                cur = Some(plane_pair(last, stride));
            }
        } else if let Some((x0, x1)) = &cur {
            let mut flags = shade;
            if j < len {
                // The next run is busy (runs alternate). Right-edge per the
                // normal data walk: multi always; single only when neither
                // this value nor the following bucket touches x/z.
                let next_unknown = bq.bucket(j).has_x() || bq.bucket(j).has_z();
                let cur_unknown = x1.iter().any(|&b| b != 0);
                if is_multi || (!cur_unknown && !next_unknown) {
                    flags |= FLAG_RIGHT_EDGE;
                }
            }
            // GPU segment ticks carry only the LOW 32 bits of the u64 time
            // (same truncation as the normal path — the shader works in
            // wrapped i32 deltas against the viewport's split start_ticks).
            pack.segments.push(PackedSegment {
                t_start: t0 as u32,
                t_end: t1 as u32,
                row_flags: flags,
            });
            pack.x0.extend_from_slice(x0);
            pack.x1.extend_from_slice(x1);
            if labeled {
                crate::format::value::format_value(
                    &mut pack.label_bytes,
                    x0,
                    x1,
                    spec.bit_width,
                    spec.radix,
                    &spec.enums,
                );
                pack.label_offsets.push(pack.label_bytes.len() as u32);
            }
        }
        // else: leading quiet run with no known value — emit nothing (see
        // module docs).
        i = j;
    }
    Ok(pack)
}
