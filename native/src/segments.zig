const std = @import("std");

pub const MOCK_CLOCK_TICK_NS: u32 = 5;
pub const MOCK_END_TICKS: u32 = 90;
pub const CYCLE_DURS = [_]u32{ 1, 2, 2, 2, 2, 2, 2, 2, 2, 1 };

pub const FLAG_SHADE: u32 = 1 << 16;
pub const FLAG_RIGHT_EDGE: u32 = 1 << 17;
pub const FLAG_RISING_EDGE: u32 = 1 << 18;
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

pub fn sameValue(a: SegValue, b: SegValue, width: u32) bool {
    const aa = valueBits(a, width);
    const bb = valueBits(b, width);
    return aa.lsb == bb.lsb and aa.msb == bb.msb;
}

pub fn packInto(dest: []u8, segs: []const PackedSegment) void {
    std.debug.assert(dest.len == segs.len * PACKED_SEGMENT_BYTES);
    @memcpy(dest, std.mem.sliceAsBytes(segs));
}
