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
pub const FLAG_RISING_EDGE_LEFT: u32 = 1 << 21;

// Segment is now lean: timing + sample_index into per-row value pools + flags.
// 4 × u32 = 16 bytes. The actual bit values live in shared x0/x1 pools indexed
// via RowInfo.
pub const PackedSegment = extern struct {
    t_start: u32,
    t_end: u32,
    row_flags: u32,
};

pub const PACKED_SEGMENT_BYTES: usize = @sizeOf(PackedSegment);

// Per-row metadata. bits_per_sample is the next power of two ≥ bit_width so
// samples never straddle u32 boundaries in the bit-packed pool. segment_start
// is this row's first instance index within its pipeline; sample index for
// instance ii of this row = ii - segment_start.
pub const RowInfo = extern struct {
    x0_offset_u32: u32,
    x1_offset_u32: u32,
    bits_per_sample: u32,
    segment_start: u32,
};

pub const ROW_INFO_BYTES: usize = @sizeOf(RowInfo);

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

pub fn nextPow2(x: u32) u32 {
    std.debug.assert(x >= 1 and x <= 32);
    var v: u32 = 1;
    while (v < x) v <<= 1;
    return v;
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

const RowAccum = struct {
    bit_width: u32 = 0, // 0 = unused row
    segment_start: u32 = 0, // first instance index in this row's pipeline
    started: bool = false,
    lsbs: std.ArrayList(u32) = .empty,
    msbs: std.ArrayList(u32) = .empty,

    fn deinit(self: *RowAccum, gpa: Allocator) void {
        self.lsbs.deinit(gpa);
        self.msbs.deinit(gpa);
    }
};

pub const MAX_ROWS: usize = 64;

pub const Scene = struct {
    gpa: Allocator,
    multi: std.ArrayList(PackedSegment) = .empty,
    single: std.ArrayList(PackedSegment) = .empty,
    rows: [MAX_ROWS]RowAccum = [_]RowAccum{.{}} ** MAX_ROWS,

    pub fn init(gpa: Allocator) Scene {
        return .{ .gpa = gpa };
    }

    pub fn deinit(self: *Scene) void {
        self.multi.deinit(self.gpa);
        self.single.deinit(self.gpa);
        for (&self.rows) |*r| r.deinit(self.gpa);
    }

    fn pushSegment(
        self: *Scene,
        target: *std.ArrayList(PackedSegment),
        row: u32,
        bit_width: u32,
        t_start: u32,
        t_end: u32,
        bits: Bits,
        flags: u32,
    ) !void {
        std.debug.assert(row < MAX_ROWS);
        var ra = &self.rows[row];
        if (!ra.started) {
            ra.bit_width = bit_width;
            ra.segment_start = @intCast(target.items.len);
            ra.started = true;
        } else {
            std.debug.assert(ra.bit_width == bit_width);
            // Row's segments must be contiguous in the pipeline so segment_start
            // suffices to derive sample_index in the shader.
            std.debug.assert(ra.segment_start + @as(u32, @intCast(ra.lsbs.items.len)) == @as(u32, @intCast(target.items.len)));
        }
        try ra.lsbs.append(self.gpa, bits.lsb);
        try ra.msbs.append(self.gpa, bits.msb);
        try target.append(self.gpa, .{
            .t_start = t_start,
            .t_end = t_end,
            .row_flags = flags,
        });
    }

    pub fn buildSegments(
        self: *Scene,
        target: *std.ArrayList(PackedSegment),
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
            try self.pushSegment(target, row, bit_width, r.t_start, r.t_end, bits, flags);
        }
    }

    pub fn buildClockSegments(
        self: *Scene,
        target: *std.ArrayList(PackedSegment),
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
            // The high half-period owns the right arm of the rising-edge caret,
            // drawn at its left boundary (every val==1 segment follows a low).
            const rising_left = val == 1;
            const flags = (row & 0xffff) |
                (if (has_next) FLAG_RIGHT_EDGE else @as(u32, 0)) |
                (if (rising) FLAG_RISING_EDGE else @as(u32, 0)) |
                (if (rising_left) FLAG_RISING_EDGE_LEFT else @as(u32, 0));
            const bits = Bits{ .lsb = val, .msb = 0 };
            try self.pushSegment(target, row, 1, start, start + half, bits, flags);
        }
    }

    pub fn buildDataSignal(
        self: *Scene,
        target: *std.ArrayList(PackedSegment),
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
            try self.pushSegment(target, p.row, p.bit_width, start, end, bits, flags);
            tick = end;
            i = j + 1;
        }
    }
};

pub const Finalized = struct {
    row_infos: std.ArrayList(RowInfo),
    x0_pool: std.ArrayList(u32),
    x1_pool: std.ArrayList(u32),

    pub fn deinit(self: *Finalized, gpa: Allocator) void {
        self.row_infos.deinit(gpa);
        self.x0_pool.deinit(gpa);
        self.x1_pool.deinit(gpa);
    }
};

// Pack a row's sample list into the shared bit-packed pool. bits_per_sample is
// pow2 ≤ 32 so samples never cross u32 boundaries.
fn packRow(pool: *std.ArrayList(u32), gpa: Allocator, samples: []const u32, bits_per_sample: u32) !u32 {
    const start_word: u32 = @intCast(pool.items.len);
    const total_bits = samples.len * bits_per_sample;
    const total_words = (total_bits + 31) / 32;
    try pool.appendNTimes(gpa, 0, total_words);
    const buf = pool.items[start_word..];
    const mask = maskForWidth(bits_per_sample);
    for (samples, 0..) |v, i| {
        const bit_off: u32 = @intCast(i * bits_per_sample);
        const word_idx = bit_off >> 5;
        const shift_amt: u5 = @intCast(bit_off & 31);
        buf[word_idx] |= (v & mask) << shift_amt;
    }
    return start_word;
}

pub fn finalize(scene: *Scene, gpa: Allocator) !Finalized {
    var max_row: usize = 0;
    for (scene.rows, 0..) |r, idx| {
        if (r.bit_width != 0) max_row = idx;
    }
    const row_count: usize = if (scene.rows[0].bit_width != 0 or max_row > 0) max_row + 1 else 0;

    var row_infos: std.ArrayList(RowInfo) = .empty;
    errdefer row_infos.deinit(gpa);
    var x0: std.ArrayList(u32) = .empty;
    errdefer x0.deinit(gpa);
    var x1: std.ArrayList(u32) = .empty;
    errdefer x1.deinit(gpa);

    try row_infos.ensureTotalCapacity(gpa, row_count);

    var i: usize = 0;
    while (i < row_count) : (i += 1) {
        const r = scene.rows[i];
        if (r.bit_width == 0) {
            row_infos.appendAssumeCapacity(.{ .x0_offset_u32 = 0, .x1_offset_u32 = 0, .bits_per_sample = 0, .segment_start = 0 });
            continue;
        }
        const bps = nextPow2(r.bit_width);
        const off0 = try packRow(&x0, gpa, r.lsbs.items, bps);
        const off1 = try packRow(&x1, gpa, r.msbs.items, bps);
        row_infos.appendAssumeCapacity(.{ .x0_offset_u32 = off0, .x1_offset_u32 = off1, .bits_per_sample = bps, .segment_start = r.segment_start });
    }

    // Shader invariant: every segment's row index must point to a populated
    // RowInfo (bits_per_sample > 0). The shader's decodeSample shifts by
    // (32 - bits_per_sample) — bits=0 would be undefined behavior in WGSL.
    // Caught here once at scene-build, not per-frame on the GPU.
    for ([_][]const PackedSegment{ scene.multi.items, scene.single.items }) |segs| {
        for (segs) |s| {
            const row = s.row_flags & 0xffff;
            std.debug.assert(row < row_infos.items.len);
            std.debug.assert(row_infos.items[row].bits_per_sample > 0);
        }
    }

    return .{ .row_infos = row_infos, .x0_pool = x0, .x1_pool = x1 };
}

pub fn packSegmentsInto(dest: []u8, segs: []const PackedSegment) void {
    std.debug.assert(dest.len == segs.len * PACKED_SEGMENT_BYTES);
    @memcpy(dest, std.mem.sliceAsBytes(segs));
}

pub fn packRowInfosInto(dest: []u8, infos: []const RowInfo) void {
    std.debug.assert(dest.len == infos.len * ROW_INFO_BYTES);
    @memcpy(dest, std.mem.sliceAsBytes(infos));
}
