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
//!   plane-0/plane-1 columns (see [`flatten`]).
//! - Absent planes read as zero: a 2-state chunk has no p1 plane — materialize
//!   zeros into the x1 pool.
//! - Times are u64; keep the low-32 truncation for GPU `PackedSegment` times
//!   (the viewport's int/frac split handles display precision).
//! - X/Z plane convention is SWAPPED vs the Zig db for unknown bits (tide.rs:
//!   X=(p0 1, p1 1), Z=(p0 0, p1 1)). Packing copies the planes VERBATIM — no
//!   translation here; the one WGSL flip is unit U6's. Every predicate below
//!   that touches unknowns ("any x1 byte non-zero" = has x/z; "x0 low byte 1,
//!   x1 zero" = logic-1) means the same thing under both conventions.

pub mod buckets;
mod cache;

use riptide_contract::gpu::{
    FLAG_FALLING_EDGE, FLAG_FALLING_EDGE_LEFT, FLAG_MUTE, FLAG_RIGHT_EDGE, FLAG_RISING_EDGE,
    FLAG_RISING_EDGE_LEFT, FLAG_SHADE, MAX_ROWS, PackedSegment, RowInfo, bytes_per_sample,
};
use riptide_contract::pack::{PackKey, PackOutput};
use riptide_contract::spec::{ClockPolarity, EnumEntry, PackKind, Radix, RowSpec};
use tide::{SignalId, SignalQuery, TimeRange};

use crate::format::value::format_value;
use crate::{Error, TraceDb};

/// The stateful packer: owns the `PackKey → packed signal` cache so an
/// add/remove/reorder/radix-change repacks only the changed signal.
#[derive(Default)]
pub struct Packer {
    cache: cache::PackCache,
    /// Fresh (non-cache-hit) signal packs performed over this packer's
    /// lifetime — tide query + flag walk + label format. Observability for
    /// the cache-reuse tests and the perf overlay.
    fresh_packs: u64,
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
        db: &mut TraceDb,
        specs: &[RowSpec],
        q_start: u64,
        q_end: u64,
    ) -> Result<PackOutput, Error> {
        let end_t = db.end_ticks();
        // Query window clamps (mirrors getMockSegments): never query past the
        // trace end; a crossed window collapses to empty. Cache entries are
        // keyed on the CALLER's raw window (what `contains` sees too).
        let win_end = q_end.min(end_t);
        let win_start = q_start.min(win_end);

        // A pan/zoom that moved the window invalidates every cached pack;
        // evicting here also bounds the cache to current-window entries.
        self.cache.retain_window(q_start, q_end);

        let keys: Vec<PackKey> = specs.iter().map(PackKey::of).collect();

        // Collect the specs that need a fresh pack (key+window not cached),
        // deduped by key (two rows showing the same signal+config share one
        // cache entry, exactly like the Zig cache).
        struct Pending<'a> {
            spec: &'a RowSpec,
            key: &'a PackKey,
            data_idx: usize,
            mute_idx: Option<usize>,
        }
        let mut ids: Vec<SignalId> = Vec::new();
        let mut pending: Vec<Pending<'_>> = Vec::new();
        for (spec, key) in specs.iter().zip(&keys) {
            if self.cache.contains(key, q_start, q_end)
                || pending.iter().any(|p| p.key == key)
            {
                continue;
            }
            let data_idx = ids.len();
            ids.push(TraceDb::handle(&spec.handle)?);
            // An unparsable mute handle falls back to the unmuted walk (the
            // Zig parseSpec treated it as "no mute"), as does a mute id the
            // db can't resolve (checked below).
            let mute_idx = if spec.kind == PackKind::Data {
                spec.mute_handle
                    .as_deref()
                    .and_then(|h| TraceDb::handle(h).ok())
                    .map(|id| {
                        let idx = ids.len();
                        ids.push(id);
                        idx
                    })
            } else {
                None
            };
            pending.push(Pending { spec, key, data_idx, mute_idx });
        }

        // One batched covering-set query for every uncached signal (data +
        // mute enables) — one coalesced extraction for whatever isn't
        // resident yet.
        if !pending.is_empty() {
            let results = db.query(&ids, TimeRange::new(win_start, win_end))?;
            for p in &pending {
                let Some(data_q) = results[p.data_idx].as_ref() else {
                    return Err(Error::UnknownHandle(p.spec.handle.clone()));
                };
                // Real/event-type signals (no logic planes) pack empty: the
                // row contributes no segments (the old code never saw these;
                // MIGRATION.md lists "must not abort" as expected-improved).
                let ps = match flatten(data_q) {
                    None => PackedSignal::default(),
                    Some(flat) => {
                        let mute_flat = p
                            .mute_idx
                            .and_then(|mi| results[mi].as_ref())
                            .and_then(flatten)
                            .filter(|m| !m.times.is_empty());
                        let opts = PackOpts {
                            width: flat.width,
                            shaded: p.spec.shaded,
                            end_t,
                            kind: p.spec.kind,
                            polarity: p.spec.polarity,
                            radix: p.spec.radix,
                            enums: &p.spec.enums,
                        };
                        pack_signal(flat, mute_flat.as_ref(), &opts)
                    }
                };
                self.fresh_packs += 1;
                self.cache.insert(p.key.clone(), q_start, q_end, ps);
            }
        }

        // Assembly: replay every spec's (now cached) PackedSignal into the
        // scene — row OR-in, sample/label append; no tide query.
        let mut scene = Scene::new();
        for (spec, key) in specs.iter().zip(&keys) {
            let ps = self
                .cache
                .get(key, q_start, q_end)
                .expect("packed above or cached");
            scene.push_packed_signal(spec.row, ps);
        }
        Ok(scene.finalize(end_t))
    }

    /// Drops every cached pack (call on trace swap — handles invalidate).
    pub fn clear(&mut self) {
        self.cache.clear();
    }

    /// Whether a cached pack exists for this key over this window (used by
    /// `sync_doc` diffing to decide if a repack is needed).
    pub fn contains(&self, key: &PackKey, q_start: u64, q_end: u64) -> bool {
        self.cache.contains(key, q_start, q_end)
    }

    /// Fresh (non-cache-hit) per-signal packs performed so far.
    pub fn fresh_packs(&self) -> u64 {
        self.fresh_packs
    }
}

// ---- per-signal packing (port of pack.zig) --------------------------------

/// One fully packed signal, independent of its row placement — the cacheable
/// unit. `row_flags` here have the low 16 bits (row index) zeroed; the row is
/// OR'd in at assembly ([`Scene::push_packed_signal`]). `lsbs`/`msbs` hold
/// `segments.len() · bytes_per_sample` bytes (tide's raw p0/p1 byte planes).
/// `label_offsets` holds `segments.len() + 1` prefix offsets when the row is
/// labeled (radix ≠ bin) and a segment exists, else stays empty.
#[derive(Debug, Default)]
struct PackedSignal {
    is_multi: bool,
    bit_width: u32,
    segments: Vec<PackedSegment>,
    lsbs: Vec<u8>,
    msbs: Vec<u8>,
    label_bytes: Vec<u8>,
    label_offsets: Vec<u32>,
}

impl PackedSignal {
    fn push_segment(&mut self, t_start: u32, t_end: u32, flags: u32) {
        self.segments.push(PackedSegment { t_start, t_end, row_flags: flags });
    }

    /// Append this segment's value label. Call once per `push_segment`, in
    /// order. Muted segments get an empty label.
    fn push_label(&mut self, x0: &[u8], x1: &[u8], radix: Radix, enums: &[EnumEntry], muted: bool) {
        if self.label_offsets.is_empty() {
            self.label_offsets.push(0);
        }
        if !muted {
            format_value(&mut self.label_bytes, x0, x1, self.bit_width, radix, enums);
        }
        self.label_offsets.push(self.label_bytes.len() as u32);
    }
}

struct PackOpts<'a> {
    width: u32,
    shaded: bool,
    /// The trace's end tick (the last segment extends to it).
    end_t: u64,
    kind: PackKind,
    polarity: ClockPolarity,
    radix: Radix,
    enums: &'a [EnumEntry],
}

/// A `SignalQuery` materialized contiguously: timestamps plus the p0/p1 byte
/// columns (one memcpy per zero-copy run; absent planes zero-filled). Sample
/// `i` = bytes `[i·stride, (i+1)·stride)` of each plane, `stride =
/// bytes_per_sample(width)` (tide's `plane::stride`). Returns `None` for
/// non-logic (real) signals.
struct FlatQuery {
    width: u32,
    times: Vec<u64>,
    x0: Vec<u8>,
    x1: Vec<u8>,
}

fn flatten(q: &SignalQuery<'_>) -> Option<FlatQuery> {
    let width = q.kind().width()?;
    let stride = bytes_per_sample(width) as usize;
    let total = usize::try_from(q.len()).expect("query fits in memory");
    let mut times = Vec::with_capacity(total);
    let mut x0 = Vec::with_capacity(total * stride);
    let mut x1 = Vec::with_capacity(total * stride);
    for run in q.segments() {
        times.extend_from_slice(run.times());
        let n = run.times().len() * stride;
        let planes = run.planes();
        for (dst, k) in [(&mut x0, 0usize), (&mut x1, 1usize)] {
            let col = planes.map(|p| p.plane(k)).unwrap_or(&[]);
            if col.is_empty() {
                dst.resize(dst.len() + n, 0); // absent plane reads as zero
            } else {
                dst.extend_from_slice(col);
            }
        }
    }
    Some(FlatQuery { width, times, x0, x1 })
}

/// True if any byte in the slice is non-zero (x/z presence: any p1 bit set
/// means the sample carries an unknown, under both plane conventions).
fn any_nonzero(bytes: &[u8]) -> bool {
    bytes.iter().any(|&b| b != 0)
}

/// True if a 1-bit mute (enable) sample is NOT exactly logic-1 — i.e. the row
/// should be muted. logic-1 == x0 low byte 1, no unknown bits; 0/x/z all mute.
fn sample_mutes(x0: &[u8], x1: &[u8]) -> bool {
    let is_one = x0.first() == Some(&1) && !any_nonzero(x1);
    !is_one
}

/// Walk a flattened query (one entry per value transition) and build a
/// row-agnostic [`PackedSignal`]: one `PackedSegment` header per transition +
/// the signal's tide byte planes carried verbatim into the value pools, plus
/// a native value label for labeled rows. Row bits are left 0 here.
fn pack_signal(flat: FlatQuery, mute: Option<&FlatQuery>, opts: &PackOpts<'_>) -> PackedSignal {
    // A muted DATA signal must split on the mute signal's edges too, not just
    // its own value changes — otherwise a mute (enable) that toggles between
    // two value transitions would never flip the mute mid-segment. That needs
    // the merged boundary walk below. Clocks are never muted (they define the
    // timebase); an unresolvable/empty mute falls back to the unmuted walk.
    if opts.kind == PackKind::Data
        && let Some(mute_q) = mute
    {
        return pack_muted_data(&flat, mute_q, opts);
    }

    // Pipeline routing is format-driven, not width-driven: bin (binary /
    // reset / clock) and boolean render high/low lines on the single
    // pipeline; hex/dec/sdec/enum render multi-bit pills. boolean
    // additionally carries a true/false value label (labeled = radix ≠ bin).
    let mut ps = PackedSignal {
        is_multi: opts.radix != Radix::Bin && opts.radix != Radix::Boolean,
        bit_width: opts.width,
        ..PackedSignal::default()
    };

    let bps = bytes_per_sample(opts.width) as usize;
    let len = flat.times.len();
    for i in 0..len {
        // GPU segment ticks carry only the LOW 32 bits of tide's u64
        // timestamp. The shader works in deltas relative to start_ticks
        // (carried in the viewport uniform as its own low 32 bits + frac),
        // and i32 subtraction wraps mod 2^32, so the wrapped low word yields
        // the correct on-screen offset for any window whose span fits i32 —
        // full absolute precision (end_ticks, cursor, query window) stays
        // u64 on the engine side.
        let t_start = flat.times[i] as u32;
        let t_end = if i + 1 < len { flat.times[i + 1] as u32 } else { opts.end_t as u32 };

        let has_next = i + 1 < len;

        let x0 = &flat.x0[i * bps..(i + 1) * bps];
        let x1 = &flat.x1[i * bps..(i + 1) * bps];

        let mut draw_right = has_next;
        let mut rising = false;
        let mut rising_left = false;
        let mut falling = false;
        let mut falling_left = false;

        match opts.kind {
            PackKind::Clk => {
                // val lives in the low byte (clock is 1-bit, 2-state). A
                // rising chevron (top of the row) straddles each 0→1
                // boundary; a falling chevron (bottom) each 1→0. Every
                // boundary is split across the two abutting half-periods:
                // the one before the edge draws its left arm at its right
                // boundary, the one after draws the right arm at its left
                // boundary. Polarity gates which chevrons emit.
                let val = x0.first().copied().unwrap_or(0);
                let want_rise = opts.polarity != ClockPolarity::Falling; // rising or both
                let want_fall = opts.polarity != ClockPolarity::Rising; // falling or both
                // Left-arm halves are gated on has_next (the right boundary
                // is an edge only if a next half-period follows). Right-arm
                // (…_LEFT) halves are gated on i > 0: the window's first
                // sample has no in-window predecessor — its left boundary is
                // at/left of q_start (offscreen), except at the trace's very
                // start (q_start == 0, fully zoomed out) where the first
                // sample is value-init, not a transition, so it must not
                // sprout a chevron either way.
                rising = want_rise && val == 0 && has_next;
                rising_left = want_rise && val == 1 && i > 0;
                falling = want_fall && val == 1 && has_next;
                falling_left = want_fall && val == 0 && i > 0;
            }
            PackKind::Data => {
                // Single-pipeline transitions touching x/z have no clean edge
                // to draw — suppress the right-edge flag on the left segment.
                if draw_right && !ps.is_multi {
                    let next_x1 = &flat.x1[(i + 1) * bps..(i + 2) * bps];
                    if any_nonzero(x1) || any_nonzero(next_x1) {
                        draw_right = false;
                    }
                }
            }
        }

        let shaded = opts.shaded && opts.kind == PackKind::Data;
        // Row bits intentionally 0 — OR'd in when placed at a row.
        let flags = if shaded { FLAG_SHADE } else { 0 }
            | if draw_right { FLAG_RIGHT_EDGE } else { 0 }
            | if rising { FLAG_RISING_EDGE } else { 0 }
            | if rising_left { FLAG_RISING_EDGE_LEFT } else { 0 }
            | if falling { FLAG_FALLING_EDGE } else { 0 }
            | if falling_left { FLAG_FALLING_EDGE_LEFT } else { 0 };

        ps.push_segment(t_start, t_end, flags);

        // Labeled rows (multi-bit pills + boolean lines) format a value label
        // here in lockstep with the segment push so labels stay aligned. bin
        // (binary / clock / reset) is the only unlabeled format.
        if opts.radix != Radix::Bin {
            ps.push_label(x0, x1, opts.radix, opts.enums, false);
        }
    }
    // The flattened planes ARE the value pools — sample run i lines up with
    // segment i (the old setSamples bulk memcpy, already done in flatten).
    ps.lsbs = flat.x0;
    ps.msbs = flat.x1;
    ps
}

/// Mute state at time `t`: the mute sample active at/before `t` (clamped to
/// index 0 for `t` left of the first in-window mute sample — that sample is
/// the one active at q_start, so it covers everything to its left on-screen).
fn mute_at(ts: &[u64], mutes: &[bool], t: u64) -> bool {
    if t < ts[0] {
        return mutes[0];
    }
    // linear-from-the-end is fine: the mute sample count in a window is tiny.
    let mut j = ts.len() - 1;
    while j > 0 && ts[j] > t {
        j -= 1;
    }
    mutes[j]
}

/// Muted DATA path: a segment boundary is emitted at every DATA value change
/// AND every MUTE (enable) edge that flips the mute state, so an arbitrary
/// enable mutes an arbitrary data signal correctly even when the enable
/// toggles mid-value. The bulk sample carry can't be used here because
/// emitted segments no longer line up 1:1 with the data query's samples —
/// each emitted segment copies the data sample active over its span.
fn pack_muted_data(data: &FlatQuery, mute: &FlatQuery, opts: &PackOpts<'_>) -> PackedSignal {
    let mut ps = PackedSignal {
        is_multi: opts.radix != Radix::Bin && opts.radix != Radix::Boolean,
        bit_width: opts.width,
        ..PackedSignal::default()
    };

    let bps = bytes_per_sample(opts.width) as usize;
    let dlen = data.times.len();
    if dlen == 0 {
        return ps;
    }

    let mbps = bytes_per_sample(mute.width) as usize;
    let mlen = mute.times.len(); // caller guarantees ≥ 1
    let mute_ts = &mute.times;
    let mutes: Vec<bool> = (0..mlen)
        .map(|k| sample_mutes(&mute.x0[k * mbps..(k + 1) * mbps], &mute.x1[k * mbps..(k + 1) * mbps]))
        .collect();

    // Walk the merged boundary timeline. Both data and mute timestamps are
    // sorted ascending. We emit a new segment at a boundary iff it is a real
    // data value change OR the mute state flips there; a mute edge that does
    // not change muteness (e.g. 0→x, both muted) is skipped so multi-bit
    // pills don't sprout a false seam. The previous emitted segment's t_end
    // is the next emitted boundary (or end_t for the last). Data values /
    // labels are sampled from the data index active over each emitted span.
    let first_t = data.times[0];
    let mut di = 0usize; // data index active at the cursor
    let mut mk = 0usize; // mute index: first mute edge strictly after first_t
    while mk < mlen && mute_ts[mk] <= first_t {
        mk += 1;
    }

    let mut prev_muted = false;
    let mut have_prev = false;
    // The open segment we have started but not yet pushed (its t_end is
    // unknown until the next emitted boundary).
    let mut open = false;
    let mut open_t = 0u64;
    let mut open_di = 0usize;
    let mut open_muted = false;

    loop {
        let dt = if di < dlen { data.times[di] } else { u64::MAX };
        let mut mt = if mk < mlen { mute_ts[mk] } else { u64::MAX };
        if mt >= opts.end_t {
            mt = u64::MAX; // mute edges past the window are offscreen-right
        }
        let b = dt.min(mt);
        if b == u64::MAX {
            break;
        }

        let is_data_edge = dt == b;
        // Advance pointers past this boundary so di/the mute cursor reflect
        // the state of the span STARTING at b.
        if dt == b {
            di += 1;
        }
        if mt == b {
            mk += 1;
        }
        let cur_di = di - 1; // data index active over [b, next)
        let muted = mute_at(mute_ts, &mutes, b);

        let emit = !have_prev || is_data_edge || (muted != prev_muted);
        if !emit {
            continue;
        }

        // Close the previously open segment at this boundary; its right
        // neighbour is the segment starting now (data index cur_di).
        if open {
            push_muted_segment(&mut ps, data, bps, open_t, b, open_di, open_muted, opts, Some(cur_di));
        }
        open = true;
        open_t = b;
        open_di = cur_di;
        open_muted = muted;
        prev_muted = muted;
        have_prev = true;
    }
    // Flush the final open segment, extending to the trace end. No right
    // neighbour.
    if open {
        push_muted_segment(&mut ps, data, bps, open_t, opts.end_t, open_di, open_muted, opts, None);
    }
    ps
}

/// Emit one muted-data segment: timing header, per-segment data sample bytes,
/// and (labeled rows only) a value label. `next_di` is the data index of the
/// following emitted segment (`None` if this is the last). A multi-bit pill
/// draws its right gap whenever a next segment exists (incl. a mute-only
/// boundary — the gap separates valid from muted). A single-bit row draws its
/// right edge only at a genuine value change (`next_di != di`) into a clean
/// (no x/z) sample; a mute-only boundary keeps the same value, so the
/// FLAG_MUTE dim conveys it without a false edge.
#[allow(clippy::too_many_arguments)]
fn push_muted_segment(
    ps: &mut PackedSignal,
    data: &FlatQuery,
    bps: usize,
    t_start_u: u64,
    t_end_u: u64,
    di: usize,
    muted: bool,
    opts: &PackOpts<'_>,
    next_di: Option<usize>,
) {
    let t_start = t_start_u as u32;
    let t_end = t_end_u as u32;
    let x0 = &data.x0[di * bps..(di + 1) * bps];
    let x1 = &data.x1[di * bps..(di + 1) * bps];

    let mut draw_right = next_di.is_some();
    if !ps.is_multi {
        draw_right = false;
        if let Some(nd) = next_di
            && nd != di
        {
            let next_x1 = &data.x1[nd * bps..(nd + 1) * bps];
            draw_right = !any_nonzero(x1) && !any_nonzero(next_x1);
        }
    }

    let flags = if opts.shaded { FLAG_SHADE } else { 0 }
        | if draw_right { FLAG_RIGHT_EDGE } else { 0 }
        | if muted { FLAG_MUTE } else { 0 };

    ps.push_segment(t_start, t_end, flags);
    ps.lsbs.extend_from_slice(x0);
    ps.msbs.extend_from_slice(x1);
    if opts.radix != Radix::Bin {
        ps.push_label(x0, x1, opts.radix, opts.enums, muted);
    }
}

// ---- scene assembly + finalize (port of segments.zig) ----------------------

#[derive(Default)]
struct RowAccum {
    bit_width: u32, // 0 = unused row
    segment_start: u32,
    started: bool,
    count: u32, // samples pushed (lsbs/msbs hold count · bytes_per_sample)
    lsbs: Vec<u8>,
    msbs: Vec<u8>,
}

struct Scene {
    multi: Vec<PackedSegment>,
    single: Vec<PackedSegment>,
    // Per-segment value labels: multi rows always carry real labels; the
    // single stream carries an entry for EVERY single segment (empty for
    // unlabeled bin/clock/reset, real text for boolean) so label i stays
    // aligned with segment i. Offsets are count+1 prefix offsets (the
    // contract pins `[0]` for an empty stream).
    multi_label_bytes: Vec<u8>,
    multi_label_offsets: Vec<u32>,
    single_label_bytes: Vec<u8>,
    single_label_offsets: Vec<u32>,
    rows: Vec<RowAccum>,
}

impl Scene {
    fn new() -> Self {
        Self {
            multi: Vec::new(),
            single: Vec::new(),
            multi_label_bytes: Vec::new(),
            multi_label_offsets: vec![0],
            single_label_bytes: Vec::new(),
            single_label_offsets: vec![0],
            rows: (0..MAX_ROWS).map(|_| RowAccum::default()).collect(),
        }
    }

    /// Place an already-packed signal at `row`: append its segments (OR'ing
    /// the row into each `row_flags`), its samples to the row's pools, and
    /// its labels to the matching label stream. This is the cache-replay path
    /// — no tide query, no flag recompute, no label format.
    fn push_packed_signal(&mut self, row: u32, ps: &PackedSignal) {
        assert!((row as usize) < MAX_ROWS, "row {row} out of range");
        if ps.segments.is_empty() {
            return; // empty signal contributes no row data
        }
        let bps = bytes_per_sample(ps.bit_width);
        let target = if ps.is_multi { &mut self.multi } else { &mut self.single };
        let ra = &mut self.rows[row as usize];
        // Each row is filled by exactly one signal, contiguously.
        assert!(!ra.started, "row {row} placed twice");
        ra.bit_width = ps.bit_width;
        ra.segment_start = target.len() as u32;
        ra.started = true;

        target.extend(ps.segments.iter().map(|s| PackedSegment {
            t_start: s.t_start,
            t_end: s.t_end,
            row_flags: (s.row_flags & !0xffff) | (row & 0xffff),
        }));
        // One memcpy of the signal's whole byte run into the row's pool. One
        // signal fills a row, so ra starts empty.
        ra.lsbs.extend_from_slice(&ps.lsbs);
        ra.msbs.extend_from_slice(&ps.msbs);
        ra.count += ps.segments.len() as u32;
        // Guards double-copy / stride drift.
        assert_eq!(ra.lsbs.len() as u32, ra.count * bps);

        // Route value labels to the stream matching the signal's pipeline.
        // has_labels is false only for bin (no push_label).
        let has_labels = !ps.label_offsets.is_empty();
        let (lbytes, loffs) = if ps.is_multi {
            (&mut self.multi_label_bytes, &mut self.multi_label_offsets)
        } else {
            (&mut self.single_label_bytes, &mut self.single_label_offsets)
        };
        for i in 0..ps.segments.len() {
            if has_labels {
                let lo = ps.label_offsets[i] as usize;
                let hi = ps.label_offsets[i + 1] as usize;
                lbytes.extend_from_slice(&ps.label_bytes[lo..hi]);
            }
            loffs.push(lbytes.len() as u32);
        }
    }

    /// Emit RowInfos + concatenated sample pools and assemble the final
    /// [`PackOutput`] (the old `finalize` + the napi marshal, fused).
    fn finalize(self, end_ticks: u64) -> PackOutput {
        let mut max_row = 0usize;
        for (idx, r) in self.rows.iter().enumerate() {
            if r.bit_width != 0 {
                max_row = idx;
            }
        }
        let row_count =
            if self.rows[0].bit_width != 0 || max_row > 0 { max_row + 1 } else { 0 };

        let mut row_infos: Vec<RowInfo> = Vec::with_capacity(row_count);
        let mut x0_pool: Vec<u8> = Vec::new();
        let mut x1_pool: Vec<u8> = Vec::new();

        for r in &self.rows[..row_count] {
            if r.bit_width == 0 {
                row_infos.push(RowInfo::default());
                continue;
            }
            let x0_offset = x0_pool.len() as u32;
            x0_pool.extend_from_slice(&r.lsbs);
            let x1_offset = x1_pool.len() as u32;
            x1_pool.extend_from_slice(&r.msbs);
            row_infos.push(RowInfo {
                x0_offset,
                x1_offset,
                bytes_per_sample: bytes_per_sample(r.bit_width),
                segment_start: r.segment_start,
                flags: 0,
                y_offset: 0,
                height: 0,
            });
        }

        // The pools are bound as array<u32> and uploaded via writeBuffer
        // (4-byte-multiple size); pad each tail to a word boundary with zeros
        // (inert in the shader's OR-fold — they sit past every sample's byte
        // run). One pad per pool, not per sample, so inter-row byte offsets
        // are unaffected.
        let pad = |pool: &mut Vec<u8>| {
            let rem = pool.len() % 4;
            if rem != 0 {
                pool.resize(pool.len() + (4 - rem), 0);
            }
        };
        pad(&mut x0_pool);
        pad(&mut x1_pool);

        // Shader invariant: every segment's row index must point to a
        // populated RowInfo (bytes_per_sample > 0) — decodeSample's loop runs
        // bytes_per_sample iterations; 0 would leave the decoded value
        // undefined. Caught here once at scene-build, not per-frame.
        for s in self.multi.iter().chain(self.single.iter()) {
            let row = (s.row_flags & 0xffff) as usize;
            assert!(row < row_infos.len());
            assert!(row_infos[row].bytes_per_sample > 0);
        }

        PackOutput {
            multi: self.multi,
            single: self.single,
            row_infos,
            x0_pool,
            x1_pool,
            multi_label_bytes: self.multi_label_bytes,
            multi_label_offsets: self.multi_label_offsets,
            single_label_bytes: self.single_label_bytes,
            single_label_offsets: self.single_label_offsets,
            end_ticks,
        }
    }
}
