const std = @import("std");
const Allocator = std.mem.Allocator;
const tide = @import("tide");
const seg = @import("segments.zig");
const label = @import("label.zig");

pub const PackKind = enum { data, clk };

// Which clock edges get a chevron (clk kind only). Mirrors the renderer's
// ClockPolarity; `both` draws rising + falling.
pub const ClockPolarity = enum { rising, falling, both };

pub const PackOpts = struct {
    width: u32,
    shaded: bool,
    end_t: u64,
    kind: PackKind = .data,
    polarity: ClockPolarity = .rising,
    mute_id: ?tide.Signal.Id = null,
    // Packing window (the same [q_start, q_end] passed to db.query for the data
    // signal). Only the muted-data path needs them — it runs a second query over
    // this window for the mute (enable) signal so it can split on its edges too.
    q_start: u64 = 0,
    q_end: u64 = 0,
    // Multi-bit rows only: how to format the pill value label (label.zig).
    radix: label.Radix = .bin,
    enums: []const label.EnumEntry = &.{},
};

// True if any byte in the slice is non-zero (used for x/z presence tests).
fn anyNonzero(bytes: []const u8) bool {
    for (bytes) |b| {
        if (b != 0) return true;
    }
    return false;
}

// The full-width little-endian byte runs of `id`'s sample at tick `t`, plus its
// declared width. `query(id, t, t)` returns the single sample active at `t`
// (tide's lo = upperBound-1). Used by getValueAt and the mute test. The
// returned slices borrow into the database storage (valid until the next query).
pub const ValueSlice = struct {
    x0: []const u8,
    x1: []const u8,
    width: u32,
};

pub fn valueAt(db: *const tide.Database, id: tide.Signal.Id, t: u64) ?ValueSlice {
    const q = db.query(id, t, t) orelse return null;
    if (q.len == 0) return null;
    const bps = q.type.bytes();
    const last = (@as(usize, @intCast(q.len)) - 1) * bps;
    return .{ .x0 = q.x0s[last .. last + bps], .x1 = q.x1s[last .. last + bps], .width = q.type.width };
}

// True if a 1-bit mute (enable) sample (low byte x0, x1 run) is NOT exactly
// logic-1 — i.e. the row should be muted. logic-1 == x0 low byte 1, no unknown
// bits; 0/x/z all mute.
fn sampleMutes(x0: []const u8, x1: []const u8) bool {
    const is_one = x0.len > 0 and x0[0] == 1 and !anyNonzero(x1);
    return !is_one;
}

// Walk a tide query (one entry per value transition) and build a row-agnostic
// PackedSignal: one PackedSegment header per transition + the signal's tide byte
// planes copied verbatim into the value pools (one bulk memcpy via setSamples, no
// repack), plus a native value label for multi-bit rows. The caller caches this and
// places it at a row via Scene.pushPackedSignal; finalize() concatenates the per-row
// byte runs into the x0/x1 pools. Flag logic mirrors mock_scene's buildClockSegments
// / buildDataSignal so the GPU output is identical to the old hardcoded path. Row
// bits are left 0 here (OR'd in at placement). The returned PackedSignal owns its
// allocations (free with deinit).
pub fn packSignal(
    gpa: Allocator,
    db: *const tide.Database,
    query: tide.Database.Query,
    opts: PackOpts,
) !seg.PackedSignal {
    // A muted DATA signal must split on the mute signal's edges too, not just its
    // own value changes — otherwise a mute (enable) that toggles between two value
    // transitions would never flip the mute mid-segment. That needs a second query
    // + a merged boundary walk, so it gets its own path. Clocks are never muted
    // (they define the timebase); an unresolvable mute signal falls back to the
    // unmuted walk below.
    if (opts.kind == .data and opts.mute_id != null) {
        if (db.query(opts.mute_id.?, opts.q_start, opts.q_end)) |mute_q| {
            return packMutedData(gpa, db, query, mute_q, opts);
        }
    }

    // Pipeline routing is format-driven, not width-driven: bin (binary / reset /
    // clock) renders on the single pipeline; hex/dec/enum render multi-bit pills.
    var ps = seg.PackedSignal{ .is_multi = opts.radix != .bin, .bit_width = opts.width };
    errdefer ps.deinit(gpa);

    const bps = query.type.bytes();
    const len: usize = @intCast(query.len);
    var i: usize = 0;
    while (i < len) : (i += 1) {
        // GPU segment ticks carry only the LOW 32 bits of tide's u64 timestamp.
        // The shader works in deltas relative to start_ticks (carried in the
        // viewport uniform as its own low 32 bits + frac), and i32 subtraction
        // wraps mod 2^32, so the wrapped low word yields the correct on-screen
        // offset for any window whose span fits i32 — full absolute precision
        // (endTicks, cursor, query window) stays u64 on the JS/Zig side.
        const t_start: u32 = @truncate(query.timestamps[i]);
        const t_end: u32 = if (i + 1 < len)
            @truncate(query.timestamps[i + 1])
        else
            @truncate(opts.end_t);

        const has_next = i + 1 < len;

        const x0 = query.x0s[i * bps .. (i + 1) * bps];
        const x1 = query.x1s[i * bps .. (i + 1) * bps];

        var draw_right = has_next;
        var rising = false;
        var rising_left = false;
        var falling = false;
        var falling_left = false;

        switch (opts.kind) {
            .clk => {
                // val lives in the low byte (clock is 1-bit, 2-state). A rising
                // chevron (top of the row) straddles each 0→1 boundary; a falling
                // chevron (bottom) each 1→0. Every boundary is split across the
                // two abutting half-periods: the one before the edge draws its
                // left arm at its right boundary, the one after draws the right
                // arm at its left boundary. Polarity gates which chevrons emit.
                const val: u8 = if (x0.len > 0) x0[0] else 0;
                const want_rise = opts.polarity != .falling; // rising or both
                const want_fall = opts.polarity != .rising; // falling or both
                // Left-arm halves are gated on has_next (the right boundary is an
                // edge only if a next half-period follows). Right-arm (…_left)
                // halves are gated on i > 0: the window's first sample has no
                // in-window predecessor — its left boundary is at/left of q_start
                // (offscreen), except at the trace's very start (q_start == 0,
                // fully zoomed out) where the first sample is value-init, not a
                // transition, so it must not sprout a chevron either way.
                rising = want_rise and val == 0 and has_next;
                rising_left = want_rise and val == 1 and i > 0;
                falling = want_fall and val == 1 and has_next;
                falling_left = want_fall and val == 0 and i > 0;
            },
            .data => {
                // Single-pipeline transitions touching x/z have no clean edge to
                // draw — suppress the right-edge flag on the left segment.
                if (draw_right and !ps.is_multi) {
                    const next_x1 = query.x1s[(i + 1) * bps .. (i + 2) * bps];
                    if (anyNonzero(x1) or anyNonzero(next_x1)) draw_right = false;
                }
            },
        }

        const shaded = opts.shaded and opts.kind == .data;
        // Row bits intentionally 0 — OR'd in when this signal is placed at a row.
        const flags = (if (shaded) seg.FLAG_SHADE else @as(u32, 0)) |
            (if (draw_right) seg.FLAG_RIGHT_EDGE else @as(u32, 0)) |
            (if (rising) seg.FLAG_RISING_EDGE else @as(u32, 0)) |
            (if (rising_left) seg.FLAG_RISING_EDGE_LEFT else @as(u32, 0)) |
            (if (falling) seg.FLAG_FALLING_EDGE else @as(u32, 0)) |
            (if (falling_left) seg.FLAG_FALLING_EDGE_LEFT else @as(u32, 0));

        try ps.pushSegment(gpa, t_start, t_end, flags);

        // Multi-bit rows render a value pill; format its label here (native) in
        // lockstep with the segment push so labels stay aligned.
        if (ps.is_multi) {
            try ps.pushLabel(gpa, x0, x1, opts.radix, opts.enums, false);
        }
    }
    // One memcpy of tide's whole byte planes into the value pools — the per-sample
    // repack is gone; the loop above now only computes timing/flags/labels. The
    // i-th bytes_per_sample-byte run lines up with segment i (tide stores x0s/x1s
    // contiguously, len·bps bytes — db.zig invariant).
    try ps.setSamples(gpa, query.x0s, query.x1s);
    return ps;
}

// Muted DATA path: a segment boundary is emitted at every DATA value change AND
// every MUTE (enable) edge that flips the mute state, so an arbitrary enable
// mutes an arbitrary data signal correctly even when the enable toggles mid-value.
// The bulk-memcpy fast path (setSamples) can't be used here because emitted
// segments no longer line up 1:1 with the data query's samples — each emitted
// segment copies the data sample active over its span individually.
fn packMutedData(
    gpa: Allocator,
    db: *const tide.Database,
    data_q: tide.Database.Query,
    mute_q: tide.Database.Query,
    opts: PackOpts,
) !seg.PackedSignal {
    _ = db;
    var ps = seg.PackedSignal{ .is_multi = opts.radix != .bin, .bit_width = opts.width };
    errdefer ps.deinit(gpa);

    const bps = data_q.type.bytes();
    const dlen: usize = @intCast(data_q.len);
    if (dlen == 0) return ps;

    const mbps = mute_q.type.bytes();
    const mlen: usize = @intCast(mute_q.len); // db.query guarantees ≥ 1

    // Snapshot mute transitions (timestamp + derived mute bit) so we hold no mute
    // borrow during the data walk — tide query slices are "valid until the next
    // query" (and the model is slated to go streaming). The enable is 1-bit, so a
    // window holds only a handful of these.
    const mute_ts = try gpa.alloc(u64, mlen);
    defer gpa.free(mute_ts);
    const mutes = try gpa.alloc(bool, mlen);
    defer gpa.free(mutes);
    {
        var k: usize = 0;
        while (k < mlen) : (k += 1) {
            mute_ts[k] = mute_q.timestamps[k];
            mutes[k] = sampleMutes(
                mute_q.x0s[k * mbps .. (k + 1) * mbps],
                mute_q.x1s[k * mbps .. (k + 1) * mbps],
            );
        }
    }

    // Mute state at time t: the mute sample active at/before t (clamp to index 0
    // for t left of the first in-window mute sample — that sample is the one
    // active at q_start, so it covers everything to its left on-screen).
    const muteAt = struct {
        fn f(ts: []const u64, mut: []const bool, t: u64) bool {
            if (t < ts[0]) return mut[0];
            // linear-from-0 is fine: callers advance t monotonically, but keep it
            // self-contained (mute sample count is tiny).
            var j: usize = ts.len - 1;
            while (j > 0 and ts[j] > t) j -= 1;
            return mut[j];
        }
    }.f;

    // Walk the merged boundary timeline. Both data and mute timestamps are sorted
    // ascending. We emit a new segment at a boundary iff it is a real data value
    // change OR the mute state flips there; a mute edge that does not change
    // muteness (e.g. 0→x, both muted) is skipped so multi-bit pills don't sprout a
    // false seam. The previous emitted segment's t_end is the next emitted
    // boundary (or end_t for the last). Data values/labels are sampled from the
    // data index active over each emitted span.
    const first_t = data_q.timestamps[0];
    var di: usize = 0; // data index active at the cursor
    var mk: usize = 0; // mute index: first mute edge strictly after first_t
    while (mk < mlen and mute_ts[mk] <= first_t) mk += 1;

    var prev_di: usize = std.math.maxInt(usize);
    var prev_muted: bool = false;
    var have_prev = false;
    // The open segment we have started but not yet pushed (its t_end is unknown
    // until the next emitted boundary).
    var open = false;
    var open_t: u64 = 0;
    var open_di: usize = 0;
    var open_muted: bool = false;

    while (true) {
        const dt: u64 = if (di < dlen) data_q.timestamps[di] else std.math.maxInt(u64);
        var mt: u64 = if (mk < mlen) mute_ts[mk] else std.math.maxInt(u64);
        if (mt >= opts.end_t) mt = std.math.maxInt(u64); // mute edges past the window are offscreen-right
        const b = @min(dt, mt);
        if (b == std.math.maxInt(u64)) break;

        const is_data_edge = (dt == b);
        // Advance pointers past this boundary so di/the mute cursor reflect the
        // state of the span STARTING at b.
        if (dt == b) di += 1;
        if (mt == b) mk += 1;
        const cur_di = di - 1; // data index active over [b, next)
        const muted = muteAt(mute_ts, mutes, b);

        const emit = !have_prev or is_data_edge or (muted != prev_muted);
        if (!emit) continue;

        // Close the previously open segment at this boundary; its right neighbour
        // is the segment starting now (data index cur_di).
        if (open) try pushMutedSegment(gpa, &ps, data_q, bps, open_t, b, open_di, open_muted, opts, cur_di);
        open = true;
        open_t = b;
        open_di = cur_di;
        open_muted = muted;
        prev_di = cur_di;
        prev_muted = muted;
        have_prev = true;
    }
    // Flush the final open segment, extending to the trace end. No right neighbour.
    if (open) try pushMutedSegment(gpa, &ps, data_q, bps, open_t, opts.end_t, open_di, open_muted, opts, null);
    return ps;
}

// Emit one muted-data segment: timing header + per-segment data sample bytes +
// (multi only) value label. `next_di` is the data index of the following emitted
// segment (null if this is the last). A multi-bit pill draws its right gap
// whenever a next segment exists (incl. a mute-only boundary — the gap separates
// valid from muted). A single-bit row draws its right edge only at a genuine
// value change (next_di != di) into a clean (no x/z) sample; a mute-only boundary
// keeps the same value, so the FLAG_MUTE dim conveys it without a false edge.
fn pushMutedSegment(
    gpa: Allocator,
    ps: *seg.PackedSignal,
    data_q: tide.Database.Query,
    bps: usize,
    t_start_u: u64,
    t_end_u: u64,
    di: usize,
    muted: bool,
    opts: PackOpts,
    next_di: ?usize,
) !void {
    const t_start: u32 = @truncate(t_start_u);
    const t_end: u32 = @truncate(t_end_u);
    const x0 = data_q.x0s[di * bps .. (di + 1) * bps];
    const x1 = data_q.x1s[di * bps .. (di + 1) * bps];

    var draw_right = next_di != null;
    if (!ps.is_multi) {
        draw_right = false;
        if (next_di) |nd| {
            if (nd != di) {
                const next_x1 = data_q.x1s[nd * bps .. (nd + 1) * bps];
                draw_right = !anyNonzero(x1) and !anyNonzero(next_x1);
            }
        }
    }

    const shaded = opts.shaded;
    const flags = (if (shaded) seg.FLAG_SHADE else @as(u32, 0)) |
        (if (draw_right) seg.FLAG_RIGHT_EDGE else @as(u32, 0)) |
        (if (muted) seg.FLAG_MUTE else @as(u32, 0));

    try ps.pushSegment(gpa, t_start, t_end, flags);
    try ps.lsbs.appendSlice(gpa, x0);
    try ps.msbs.appendSlice(gpa, x1);
    if (ps.is_multi) try ps.pushLabel(gpa, x0, x1, opts.radix, opts.enums, muted);
}
