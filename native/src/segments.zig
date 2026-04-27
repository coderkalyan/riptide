const std = @import("std");
const Allocator = std.mem.Allocator;

pub const MOCK_CLOCK_TICK_NS: u32 = 5;
pub const MOCK_END_TICKS: u32 = 90;
pub const CYCLE_DURS = [_]u32{ 1, 2, 2, 2, 2, 2, 2, 2, 2, 1 };

pub const FLAG_SHADE: u32 = 1 << 16;
pub const FLAG_RIGHT_EDGE: u32 = 1 << 17;
pub const FLAG_RISING_EDGE: u32 = 1 << 18;
pub const FLAG_FALLING_EDGE: u32 = 1 << 19;
pub const FLAG_MUTE: u32 = 1 << 20;

// extern struct guarantees C ABI layout (5 contiguous u32, no reordering, no
// padding) so a list of these is bit-identical to the GPU storage buffer.
pub const PackedSegment = extern struct {
    t_start: u32,
    t_end: u32,
    value_lsb: u32,
    value_msb: u32,
    row_flags: u32,
};

pub const PACKED_SEGMENT_BYTES: usize = @sizeOf(PackedSegment);

pub const SegValue = union(enum) {
    num: u32,
    x: void,
    z: void,
    raw: struct { lsb: u32, msb: u32 },
};

pub const RawSegmentSpec = struct {
    t_start: u32,
    t_end: u32,
    value: SegValue,
    muted: bool = false,
};

pub const DataSignalSpec = struct {
    row: u32,
    bit_width: u32,
    values: []const SegValue,
    muted: ?[]const bool = null,
    shaded: bool = true,
};

const Bits = struct { lsb: u32, msb: u32 };

pub fn maskForWidth(width: u32) u32 {
    if (width == 0 or width > 32) @panic("invalid bit width");
    if (width == 32) return 0xffff_ffff;
    const w: u5 = @intCast(width);
    return (@as(u32, 1) << w) - 1;
}

pub fn valueBits(v: SegValue, width: u32) Bits {
    const mask = maskForWidth(width);
    return switch (v) {
        .x => .{ .lsb = 0, .msb = mask },
        .z => .{ .lsb = mask, .msb = mask },
        .num => |n| .{ .lsb = n & mask, .msb = 0 },
        .raw => |r| .{ .lsb = r.lsb & mask, .msb = r.msb & mask },
    };
}

fn sameValue(a: SegValue, b: SegValue, width: u32) bool {
    const aa = valueBits(a, width);
    const bb = valueBits(b, width);
    return aa.lsb == bb.lsb and aa.msb == bb.msb;
}

pub fn buildSegments(
    list: *std.ArrayList(PackedSegment),
    gpa: Allocator,
    row: u32,
    bit_width: u32,
    raw: []const RawSegmentSpec,
    shaded: bool,
) !void {
    for (raw, 0..) |r, i| {
        const bits = valueBits(r.value, bit_width);
        const has_next = i + 1 < raw.len;
        const flags = (row & 0xffff) |
            (if (shaded) FLAG_SHADE else @as(u32, 0)) |
            (if (has_next) FLAG_RIGHT_EDGE else @as(u32, 0)) |
            (if (r.muted) FLAG_MUTE else @as(u32, 0));
        try list.append(gpa, .{
            .t_start = r.t_start,
            .t_end = r.t_end,
            .value_lsb = bits.lsb,
            .value_msb = bits.msb,
            .row_flags = flags,
        });
    }
}

pub fn buildClockSegments(
    list: *std.ArrayList(PackedSegment),
    gpa: Allocator,
    row: u32,
) !void {
    const half = MOCK_CLOCK_TICK_NS;
    const count = MOCK_END_TICKS / half;
    var i: u32 = 0;
    while (i < count) : (i += 1) {
        const val: u32 = i % 2;
        const start = i * half;
        const has_next = i + 1 < count;
        const rising = val == 0 and has_next;
        const flags = (row & 0xffff) |
            (if (has_next) FLAG_RIGHT_EDGE else @as(u32, 0)) |
            (if (rising) FLAG_RISING_EDGE else @as(u32, 0));
        try list.append(gpa, .{
            .t_start = start,
            .t_end = start + half,
            .value_lsb = val,
            .value_msb = 0,
            .row_flags = flags,
        });
    }
}

pub fn buildDataSignal(
    list: *std.ArrayList(PackedSegment),
    gpa: Allocator,
    p: DataSignalSpec,
) !void {
    if (p.values.len != CYCLE_DURS.len) @panic("values length must equal CYCLE_DURS length");
    var i: usize = 0;
    var tick: u32 = 0;
    while (i < p.values.len) {
        const start = tick;
        const m_at_i = if (p.muted) |m| m[i] else false;
        var j: usize = i;
        while (j + 1 < p.values.len) {
            const m_at_jp1 = if (p.muted) |m| m[j + 1] else false;
            if (!sameValue(p.values[j], p.values[j + 1], p.bit_width)) break;
            if (m_at_jp1 != m_at_i) break;
            j += 1;
        }
        var end = start;
        var k = i;
        while (k <= j) : (k += 1) end += CYCLE_DURS[k] * MOCK_CLOCK_TICK_NS;
        const bits = valueBits(p.values[i], p.bit_width);
        const has_next = j + 1 < p.values.len;
        var draw_right = has_next;
        if (draw_right and p.bit_width == 1) {
            const next_bits = valueBits(p.values[j + 1], p.bit_width);
            if (bits.msb != 0 or next_bits.msb != 0) draw_right = false;
        }
        const flags = (p.row & 0xffff) |
            (if (p.shaded) FLAG_SHADE else @as(u32, 0)) |
            (if (draw_right) FLAG_RIGHT_EDGE else @as(u32, 0)) |
            (if (m_at_i) FLAG_MUTE else @as(u32, 0));
        try list.append(gpa, .{
            .t_start = start,
            .t_end = end,
            .value_lsb = bits.lsb,
            .value_msb = bits.msb,
            .row_flags = flags,
        });
        tick = end;
        i = j + 1;
    }
}

pub fn packInto(dest: []u8, segs: []const PackedSegment) void {
    std.debug.assert(dest.len == segs.len * PACKED_SEGMENT_BYTES);
    @memcpy(dest, std.mem.sliceAsBytes(segs));
}
