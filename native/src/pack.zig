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
    end_t: u32,
    kind: PackKind = .data,
    polarity: ClockPolarity = .rising,
    gate_id: ?tide.Signal.Id = null,
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
// (tide's lo = upperBound-1). Used by getValueAt and the gate-mute test. The
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

// A gated signal (e.g. in_data behind in_valid) is muted whenever its gate is
// not exactly logic-1. Matches main's MUTE_IN/MUTE_OUT derivation. The gate is
// 1-bit, so logic-1 == low byte 1, no unknown bits.
fn gateMutedAt(db: *const tide.Database, gate_id: tide.Signal.Id, t: u64) bool {
    const v = valueAt(db, gate_id, t) orelse return true;
    const is_one = v.x0.len > 0 and v.x0[0] == 1 and !anyNonzero(v.x1);
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
    // Pipeline routing is format-driven, not width-driven: bin (binary / reset /
    // clock) renders on the single pipeline; hex/dec/enum render multi-bit pills.
    var ps = seg.PackedSignal{ .is_multi = opts.radix != .bin, .bit_width = opts.width };
    errdefer ps.deinit(gpa);

    const bps = query.type.bytes();
    const len: usize = @intCast(query.len);
    var i: usize = 0;
    while (i < len) : (i += 1) {
        // Tick path is u32 at the GPU boundary; @intCast panics (ReleaseSafe) on
        // overflow rather than wrapping. Traces exceeding 2^32 ticks need a u64
        // widening — see TIDE_INTEGRATION.md §3.10.
        std.debug.assert(query.timestamps[i] <= std.math.maxInt(u32));
        const t_start: u32 = @intCast(query.timestamps[i]);
        const t_end: u32 = if (i + 1 < len)
            @intCast(query.timestamps[i + 1]) // same u32 tick ceiling as t_start
        else
            opts.end_t;

        const has_next = i + 1 < len;

        // Compute the gate-mute BEFORE acquiring the x0/x1 slices below.
        // gateMutedAt runs a nested db.query, and tide query slices borrow into
        // db storage ("valid until the next query") — so we must not hold the
        // x0/x1 borrows across that nested query.
        const muted = if (opts.gate_id) |gid|
            gateMutedAt(db, gid, query.timestamps[i])
        else
            false;

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
            (if (falling_left) seg.FLAG_FALLING_EDGE_LEFT else @as(u32, 0)) |
            (if (muted) seg.FLAG_MUTE else @as(u32, 0));

        try ps.pushSegment(gpa, t_start, t_end, flags);

        // Multi-bit rows render a value pill; format its label here (native) in
        // lockstep with the segment push so labels stay aligned.
        if (ps.is_multi) {
            try ps.pushLabel(gpa, x0, x1, opts.radix, opts.enums, muted);
        }
    }
    // One memcpy of tide's whole byte planes into the value pools — the per-sample
    // repack is gone; the loop above now only computes timing/flags/labels. The
    // i-th bytes_per_sample-byte run lines up with segment i (tide stores x0s/x1s
    // contiguously, len·bps bytes — db.zig invariant).
    try ps.setSamples(gpa, query.x0s, query.x1s);
    return ps;
}
