const std = @import("std");
const Allocator = std.mem.Allocator;
const label = @import("label.zig");

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

// Per-row metadata. words_per_sample is ceil(bit_width / 32): each sample
// occupies that many consecutive u32 words in the pool (full declared width,
// little-endian, zero-padded — same layout as tide's per-sample byte run, just
// word-granular). segment_start is this row's first instance index within its
// pipeline; sample index for instance ii of this row = ii - segment_start.
pub const RowInfo = extern struct {
    x0_offset_u32: u32,
    x1_offset_u32: u32,
    words_per_sample: u32,
    segment_start: u32,
    // Per-row render flags (bit 0 = dim; see ROW_FLAG_DIM in digital.wgsl /
    // digital.ts). Native always emits 0 — the renderer sets this directly in
    // the GPU rowInfo buffer (eye toggle) without a repack.
    flags: u32,
};

pub const ROW_FLAG_DIM: u32 = 1 << 0;

pub const ROW_INFO_BYTES: usize = @sizeOf(RowInfo);

// Number of u32 words each sample of a `width`-bit signal occupies in the pools.
pub fn wordsPerSample(width: u32) u32 {
    std.debug.assert(width >= 1);
    return (width + 31) / 32;
}

// Append `words` u32 words read little-endian from `bytes` (tide's per-sample
// byte run), zero-padding when `bytes` is shorter than 4·words.
fn appendWords(pool: *std.ArrayList(u32), gpa: Allocator, bytes: []const u8, words: u32) !void {
    var w: u32 = 0;
    while (w < words) : (w += 1) {
        var word: u32 = 0;
        var b: u32 = 0;
        while (b < 4) : (b += 1) {
            const idx = w * 4 + b;
            if (idx < bytes.len) word |= @as(u32, bytes[idx]) << @intCast(b * 8);
        }
        try pool.append(gpa, word);
    }
}

const RowAccum = struct {
    bit_width: u32 = 0, // 0 = unused row
    segment_start: u32 = 0, // first instance index in this row's pipeline
    started: bool = false,
    count: u32 = 0, // number of samples pushed (lsbs/msbs hold count·words_per_sample)
    lsbs: std.ArrayList(u32) = .empty,
    msbs: std.ArrayList(u32) = .empty,

    fn deinit(self: *RowAccum, gpa: Allocator) void {
        self.lsbs.deinit(gpa);
        self.msbs.deinit(gpa);
    }
};

pub const MAX_ROWS: usize = 64;

// One fully packed signal, independent of its row placement — the cacheable unit
// (main.zig keys these by signal+config and reuses them across repacks, so an
// add/remove/reorder only queries tide + formats labels for the changed signal).
// `row_flags` here have the low 16 bits (row index) zeroed; the row is OR'd in at
// assembly (pushPackedSignal). `lsbs`/`msbs` hold segments.len·words_per_sample
// words. `label_offsets` holds segments.len+1 prefix offsets when `is_multi` and a
// segment exists (label i = label_bytes[off[i]..off[i+1]]), else stays empty.
pub const PackedSignal = struct {
    is_multi: bool = false,
    bit_width: u32 = 0,
    segments: std.ArrayList(PackedSegment) = .empty,
    lsbs: std.ArrayList(u32) = .empty,
    msbs: std.ArrayList(u32) = .empty,
    label_bytes: std.ArrayList(u8) = .empty,
    label_offsets: std.ArrayList(u32) = .empty,

    pub fn deinit(self: *PackedSignal, gpa: Allocator) void {
        self.segments.deinit(gpa);
        self.lsbs.deinit(gpa);
        self.msbs.deinit(gpa);
        self.label_bytes.deinit(gpa);
        self.label_offsets.deinit(gpa);
    }

    // Append one transition while building the signal (called by pack.packSignal).
    // `flags` must NOT carry row bits. `x0`/`x1` are tide's per-sample byte runs,
    // packed into words_per_sample zero-padded u32 words.
    pub fn pushSegment(
        self: *PackedSignal,
        gpa: Allocator,
        t_start: u32,
        t_end: u32,
        x0: []const u8,
        x1: []const u8,
        flags: u32,
    ) !void {
        const words = wordsPerSample(self.bit_width);
        try appendWords(&self.lsbs, gpa, x0, words);
        try appendWords(&self.msbs, gpa, x1, words);
        try self.segments.append(gpa, .{ .t_start = t_start, .t_end = t_end, .row_flags = flags });
    }

    // Append this segment's value label (multi-bit rows only). Call once per
    // pushSegment, in order. Muted segments get an empty label.
    pub fn pushLabel(
        self: *PackedSignal,
        gpa: Allocator,
        x0: []const u8,
        x1: []const u8,
        radix: label.Radix,
        enums: []const label.EnumEntry,
        muted: bool,
    ) !void {
        if (self.label_offsets.items.len == 0) try self.label_offsets.append(gpa, 0);
        if (!muted) try label.formatValue(&self.label_bytes, gpa, x0, x1, self.bit_width, radix, enums);
        try self.label_offsets.append(gpa, @intCast(self.label_bytes.items.len));
    }
};

pub const Scene = struct {
    gpa: Allocator,
    multi: std.ArrayList(PackedSegment) = .empty,
    single: std.ArrayList(PackedSegment) = .empty,
    // Per multi-bit segment value label, formatted natively (label.zig) so the
    // renderer needs no per-segment getValueAt + JS formatting. `multi_label_bytes`
    // is the concatenated ASCII; `multi_label_offsets` holds multiCount+1 prefix
    // offsets aligned with `multi` (label i = bytes[off[i]..off[i+1]]).
    multi_label_bytes: std.ArrayList(u8) = .empty,
    multi_label_offsets: std.ArrayList(u32) = .empty,
    rows: [MAX_ROWS]RowAccum = [_]RowAccum{.{}} ** MAX_ROWS,

    pub fn init(gpa: Allocator) Scene {
        return .{ .gpa = gpa };
    }

    pub fn deinit(self: *Scene) void {
        self.multi.deinit(self.gpa);
        self.single.deinit(self.gpa);
        self.multi_label_bytes.deinit(self.gpa);
        self.multi_label_offsets.deinit(self.gpa);
        for (&self.rows) |*r| r.deinit(self.gpa);
    }

    // Place an already-packed signal at `row`: append its segments to `target`
    // (OR'ing the row into each row_flags), its samples to the row's pools, and its
    // labels to the multi label buffers. This is the cache-replay path — no tide
    // query, no flag recompute, no label format. `target` must be `multi` for an
    // is_multi signal, `single` otherwise.
    pub fn pushPackedSignal(self: *Scene, target: *std.ArrayList(PackedSegment), row: u32, ps: *const PackedSignal) !void {
        std.debug.assert(row < MAX_ROWS);
        if (ps.segments.items.len == 0) return; // empty signal contributes no row data
        const wps = wordsPerSample(ps.bit_width);
        var ra = &self.rows[row];
        // Each row is filled by exactly one signal, contiguously.
        std.debug.assert(!ra.started);
        ra.bit_width = ps.bit_width;
        ra.segment_start = @intCast(target.items.len);
        ra.started = true;

        for (ps.segments.items, 0..) |s, i| {
            try ra.lsbs.appendSlice(self.gpa, ps.lsbs.items[i * wps .. (i + 1) * wps]);
            try ra.msbs.appendSlice(self.gpa, ps.msbs.items[i * wps .. (i + 1) * wps]);
            ra.count += 1;
            try target.append(self.gpa, .{
                .t_start = s.t_start,
                .t_end = s.t_end,
                .row_flags = (s.row_flags & ~@as(u32, 0xffff)) | (row & 0xffff),
            });
        }

        if (ps.is_multi) {
            if (self.multi_label_offsets.items.len == 0) try self.multi_label_offsets.append(self.gpa, 0);
            for (0..ps.segments.items.len) |i| {
                const lo = ps.label_offsets.items[i];
                const hi = ps.label_offsets.items[i + 1];
                try self.multi_label_bytes.appendSlice(self.gpa, ps.label_bytes.items[lo..hi]);
                try self.multi_label_offsets.append(self.gpa, @intCast(self.multi_label_bytes.items.len));
            }
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

// Append a row's already word-packed sample stream into the shared pool and
// return its starting word offset. The samples are word-stride (one sample =
// words_per_sample consecutive words), so this is a plain copy.
fn packRow(pool: *std.ArrayList(u32), gpa: Allocator, words: []const u32) !u32 {
    const start_word: u32 = @intCast(pool.items.len);
    try pool.appendSlice(gpa, words);
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
            row_infos.appendAssumeCapacity(.{ .x0_offset_u32 = 0, .x1_offset_u32 = 0, .words_per_sample = 0, .segment_start = 0, .flags = 0 });
            continue;
        }
        const wps = wordsPerSample(r.bit_width);
        const off0 = try packRow(&x0, gpa, r.lsbs.items);
        const off1 = try packRow(&x1, gpa, r.msbs.items);
        row_infos.appendAssumeCapacity(.{ .x0_offset_u32 = off0, .x1_offset_u32 = off1, .words_per_sample = wps, .segment_start = r.segment_start, .flags = 0 });
    }

    // Shader invariant: every segment's row index must point to a populated
    // RowInfo (words_per_sample > 0). decodeSample's loop runs words_per_sample
    // iterations — 0 would leave the decoded value undefined. Caught here once
    // at scene-build, not per-frame on the GPU.
    for ([_][]const PackedSegment{ scene.multi.items, scene.single.items }) |segs| {
        for (segs) |s| {
            const row = s.row_flags & 0xffff;
            std.debug.assert(row < row_infos.items.len);
            std.debug.assert(row_infos.items[row].words_per_sample > 0);
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
