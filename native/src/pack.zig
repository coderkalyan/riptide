const std = @import("std");
const Allocator = std.mem.Allocator;
const tide = @import("tide");
const seg = @import("segments.zig");

pub const PackKind = enum { data, clk };

pub const PackOpts = struct {
    row: u32,
    width: u32,
    shaded: bool,
    end_t: u32,
    kind: PackKind = .data,
    gate_id: ?tide.Signal.Id = null,
};

// Read a little-endian byte slice (tide stores `bytes_per_sample` bytes per
// sample, full width) into a 32-bit lsb/msb pair the way the pool/shader
// convention expects. Width ≤ 32 ⇒ ≤ 4 bytes, so this never overflows.
fn readBits(x0: []const u8, x1: []const u8) seg.Bits {
    var lsb: u32 = 0;
    var msb: u32 = 0;
    for (x0, 0..) |b, i| lsb |= @as(u32, b) << @intCast(i * 8);
    for (x1, 0..) |b, i| msb |= @as(u32, b) << @intCast(i * 8);
    return .{ .lsb = lsb, .msb = msb };
}

// Value (lsb/msb) of `id` at tick `t`. `query(id, t, t)` returns the single
// sample active at `t` (tide's lo = upperBound-1). Used by the value column and
// the gate-mute test.
pub fn valueAt(db: *const tide.Database, id: tide.Signal.Id, t: u64) ?seg.Bits {
    const q = db.query(id, t, t) orelse return null;
    if (q.len == 0) return null;
    const bps = q.type.bytes();
    const last = (@as(usize, @intCast(q.len)) - 1) * bps;
    return readBits(q.x0s[last .. last + bps], q.x1s[last .. last + bps]);
}

// A gated signal (e.g. in_data behind in_valid) is muted whenever its gate is
// not exactly logic-1. Matches main's MUTE_IN/MUTE_OUT derivation.
fn gateMutedAt(db: *const tide.Database, gate_id: tide.Signal.Id, t: u64) bool {
    const v = valueAt(db, gate_id, t) orelse return true;
    return !(v.lsb == 1 and v.msb == 0);
}

// Walk a tide query (one entry per value transition) and push each transition
// into the scene as one PackedSegment + one pooled (lsb,msb) sample. The scene's
// finalize() later bit-packs the per-row sample lists into x0/x1 pools. Flag
// logic mirrors mock_scene's buildClockSegments / buildDataSignal so the GPU
// output is identical to the old hardcoded path.
pub fn packQuery(
    scene: *seg.Scene,
    target: *std.ArrayList(seg.PackedSegment),
    db: *const tide.Database,
    query: tide.Database.Query,
    opts: PackOpts,
) !void {
    const bps = query.type.bytes();
    const len: usize = @intCast(query.len);
    var i: usize = 0;
    while (i < len) : (i += 1) {
        const t_start: u32 = @intCast(query.timestamps[i]);
        const t_end: u32 = if (i + 1 < len)
            @intCast(query.timestamps[i + 1])
        else
            opts.end_t;

        const bits = readBits(
            query.x0s[i * bps .. (i + 1) * bps],
            query.x1s[i * bps .. (i + 1) * bps],
        );

        const has_next = i + 1 < len;
        var draw_right = has_next;
        var rising = false;
        var rising_left = false;

        switch (opts.kind) {
            .clk => {
                // val lives in lsb (clock is 2-state, msb == 0). The low
                // half-period (val==0) owns the rising caret's left arm at its
                // right boundary; the high half-period (val==1) owns the right
                // arm at its left boundary.
                const val = bits.lsb;
                rising = (val == 0) and has_next;
                rising_left = (val == 1);
            },
            .data => {
                // Single-bit transitions touching x/z have no clean edge to
                // draw — suppress the right-edge flag on the left segment.
                if (draw_right and opts.width == 1) {
                    const next = readBits(
                        query.x0s[(i + 1) * bps .. (i + 2) * bps],
                        query.x1s[(i + 1) * bps .. (i + 2) * bps],
                    );
                    if (bits.msb != 0 or next.msb != 0) draw_right = false;
                }
            },
        }

        const muted = if (opts.gate_id) |gid|
            gateMutedAt(db, gid, query.timestamps[i])
        else
            false;

        const shaded = opts.shaded and opts.kind == .data;
        const flags = (opts.row & 0xffff) |
            (if (shaded) seg.FLAG_SHADE else @as(u32, 0)) |
            (if (draw_right) seg.FLAG_RIGHT_EDGE else @as(u32, 0)) |
            (if (rising) seg.FLAG_RISING_EDGE else @as(u32, 0)) |
            (if (rising_left) seg.FLAG_RISING_EDGE_LEFT else @as(u32, 0)) |
            (if (muted) seg.FLAG_MUTE else @as(u32, 0));

        try scene.pushSegment(target, opts.row, opts.width, t_start, t_end, bits, flags);
    }
}
