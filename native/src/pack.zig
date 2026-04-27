const std = @import("std");
const Allocator = std.mem.Allocator;
const tide = @import("tide");
const seg = @import("segments.zig");

pub const PackKind = enum { data, clk };

pub const PackOpts = struct {
    row: u32,
    width: u32,
    shaded: bool,
    kind: PackKind = .data,
    gate_id: ?tide.Signal.Id = null,
};

fn readBits(x0: []const u8, x1: []const u8) struct { lsb: u32, msb: u32 } {
    var lsb: u32 = 0;
    var msb: u32 = 0;
    for (x0, 0..) |b, i| lsb |= @as(u32, b) << @intCast(i * 8);
    for (x1, 0..) |b, i| msb |= @as(u32, b) << @intCast(i * 8);
    return .{ .lsb = lsb, .msb = msb };
}

fn gateMutedAt(db: *const tide.Database, gate_id: tide.Signal.Id, t: u64) bool {
    const q = db.query(gate_id, t, t) orelse return true;
    const bps = q.type.bytes();
    const last = (@as(usize, @intCast(q.len)) - 1) * bps;
    const lsb = q.x0s[last];
    const msb = q.x1s[last];
    return !(lsb == 1 and msb == 0);
}

pub fn packQuery(
    list: *std.ArrayList(seg.PackedSegment),
    gpa: Allocator,
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
            seg.MOCK_END_TICKS;

        const bits = readBits(
            query.x0s[i * bps .. (i + 1) * bps],
            query.x1s[i * bps .. (i + 1) * bps],
        );

        const has_next = i + 1 < len;
        var draw_right = has_next;
        var rising = false;

        switch (opts.kind) {
            .clk => {
                rising = (bits.lsb == 0 and bits.msb == 0) and has_next;
            },
            .data => {
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
            (if (muted) seg.FLAG_MUTE else @as(u32, 0));

        try list.append(gpa, .{
            .t_start = t_start,
            .t_end = t_end,
            .value_lsb = bits.lsb,
            .value_msb = bits.msb,
            .row_flags = flags,
        });
    }
}
