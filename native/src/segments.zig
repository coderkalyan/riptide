const std = @import("std");
const Allocator = std.mem.Allocator;
const label = @import("label.zig");

pub const FLAG_SHADE: u32 = 1 << 16;
pub const FLAG_RIGHT_EDGE: u32 = 1 << 17;
pub const FLAG_RISING_EDGE: u32 = 1 << 18;
pub const FLAG_FALLING_EDGE: u32 = 1 << 19;
pub const FLAG_MUTE: u32 = 1 << 20;
pub const FLAG_RISING_EDGE_LEFT: u32 = 1 << 21;
pub const FLAG_FALLING_EDGE_LEFT: u32 = 1 << 22;

// Segment is now lean: timing (t_start, t_end) + row_flags (row index + edge/shade
// bits). 3 × u32 = 12 bytes. The actual bit values live in shared x0/x1 pools,
// indexed via RowInfo (sample index = instance_index - RowInfo.segment_start).
pub const PackedSegment = extern struct {
    t_start: u32,
    t_end: u32,
    row_flags: u32,
};

pub const PACKED_SEGMENT_BYTES: usize = @sizeOf(PackedSegment);

// Per-row metadata. bytes_per_sample is ceil(bit_width / 8) (= tide's
// Type.bytes()): each sample occupies that many consecutive bytes in the pool —
// tide's native per-sample byte run, little-endian, memcpy'd straight in (no word
// repacking). x0_offset/x1_offset are BYTE offsets into the (u32-typed) pools.
// segment_start is this row's first instance index within its pipeline; sample
// index for instance ii of this row = ii - segment_start.
pub const RowInfo = extern struct {
    x0_offset: u32,
    x1_offset: u32,
    bytes_per_sample: u32,
    segment_start: u32,
    // Per-row render flags (bit 0 = dim; see ROW_FLAG_DIM in digital.wgsl /
    // digital.ts). Native always emits 0 — the renderer sets this directly in
    // the GPU rowInfo buffer (eye toggle) without a repack.
    flags: u32,
    // Per-row vertical placement, CSS px stored as f32 bits (the shader bitcasts
    // them). y_offset = the row's top in canvas space, height = its drawn height.
    // Native always emits 0 — the renderer writes the live layout into the GPU
    // rowInfo buffer (row resize) without a repack, same as `flags`.
    y_offset: u32,
    height: u32,
};

pub const ROW_FLAG_DIM: u32 = 1 << 0;

pub const ROW_INFO_BYTES: usize = @sizeOf(RowInfo);

// Number of bytes each sample of a `width`-bit signal occupies in the pools —
// tide's native stride (Type.bytes() = ceil(width/8)), memcpy'd directly.
pub fn bytesPerSample(width: u32) u32 {
    std.debug.assert(width >= 1);
    return (width + 7) / 8;
}

// ceil(width / 32) — the u32-word count used ONLY by the CPU value path
// (main.zig getValueAt / jsWordArray), which is independent of the GPU pools and
// keeps its word-array return shape. Not used by the byte-stride pools.
pub fn wordsPerSample(width: u32) u32 {
    std.debug.assert(width >= 1);
    return (width + 31) / 32;
}

const RowAccum = struct {
    bit_width: u32 = 0, // 0 = unused row
    segment_start: u32 = 0, // first instance index in this row's pipeline
    started: bool = false,
    count: u32 = 0, // number of samples pushed (lsbs/msbs hold count·bytes_per_sample)
    lsbs: std.ArrayList(u8) = .empty,
    msbs: std.ArrayList(u8) = .empty,

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
// assembly (pushPackedSignal). `lsbs`/`msbs` hold segments.len·bytes_per_sample
// bytes (tide's raw byte planes, copied in one memcpy by setSamples).
// `label_offsets` holds segments.len+1 prefix offsets when `is_multi` and a
// segment exists (label i = label_bytes[off[i]..off[i+1]]), else stays empty.
pub const PackedSignal = struct {
    is_multi: bool = false,
    bit_width: u32 = 0,
    segments: std.ArrayList(PackedSegment) = .empty,
    lsbs: std.ArrayList(u8) = .empty,
    msbs: std.ArrayList(u8) = .empty,
    label_bytes: std.ArrayList(u8) = .empty,
    label_offsets: std.ArrayList(u32) = .empty,

    pub fn deinit(self: *PackedSignal, gpa: Allocator) void {
        self.segments.deinit(gpa);
        self.lsbs.deinit(gpa);
        self.msbs.deinit(gpa);
        self.label_bytes.deinit(gpa);
        self.label_offsets.deinit(gpa);
    }

    // Append one transition's timing+flags header (called by pack.packSignal).
    // `flags` must NOT carry row bits. Sample bytes are NOT copied here — they're
    // bulk-copied once via setSamples (tide's whole byte plane in one memcpy).
    pub fn pushSegment(self: *PackedSignal, gpa: Allocator, t_start: u32, t_end: u32, flags: u32) !void {
        try self.segments.append(gpa, .{ .t_start = t_start, .t_end = t_end, .row_flags = flags });
    }

    // Copy tide's full per-signal byte planes (x0s/x1s, len·bytes_per_sample bytes
    // each) verbatim into the value pools — the single memcpy that replaces the old
    // per-sample byte→word repack. Call once, after all pushSegment calls; the i-th
    // bytes_per_sample-byte run lines up with segment i.
    pub fn setSamples(self: *PackedSignal, gpa: Allocator, x0s: []const u8, x1s: []const u8) !void {
        try self.lsbs.appendSlice(gpa, x0s);
        try self.msbs.appendSlice(gpa, x1s);
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
        const bps = bytesPerSample(ps.bit_width);
        var ra = &self.rows[row];
        // Each row is filled by exactly one signal, contiguously.
        std.debug.assert(!ra.started);
        ra.bit_width = ps.bit_width;
        ra.segment_start = @intCast(target.items.len);
        ra.started = true;

        for (ps.segments.items) |s| {
            try target.append(self.gpa, .{
                .t_start = s.t_start,
                .t_end = s.t_end,
                .row_flags = (s.row_flags & ~@as(u32, 0xffff)) | (row & 0xffff),
            });
        }
        // One memcpy of the signal's whole byte run into the row's pool (replaces
        // the per-segment slice copy). One signal fills a row, so ra starts empty.
        try ra.lsbs.appendSlice(self.gpa, ps.lsbs.items);
        try ra.msbs.appendSlice(self.gpa, ps.msbs.items);
        ra.count += @intCast(ps.segments.items.len);
        std.debug.assert(ra.lsbs.items.len == ra.count * bps); // guards double-copy / stride drift

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
    x0_pool: std.ArrayList(u8),
    x1_pool: std.ArrayList(u8),

    pub fn deinit(self: *Finalized, gpa: Allocator) void {
        self.row_infos.deinit(gpa);
        self.x0_pool.deinit(gpa);
        self.x1_pool.deinit(gpa);
    }
};

// Append a row's byte-stride sample stream into the shared pool and return its
// starting BYTE offset. The samples are tide's raw byte run (one sample =
// bytes_per_sample consecutive bytes), so this is a plain memcpy.
fn packRow(pool: *std.ArrayList(u8), gpa: Allocator, bytes: []const u8) !u32 {
    const start_byte: u32 = @intCast(pool.items.len);
    try pool.appendSlice(gpa, bytes);
    return start_byte;
}

pub fn finalize(scene: *Scene, gpa: Allocator) !Finalized {
    var max_row: usize = 0;
    for (scene.rows, 0..) |r, idx| {
        if (r.bit_width != 0) max_row = idx;
    }
    const row_count: usize = if (scene.rows[0].bit_width != 0 or max_row > 0) max_row + 1 else 0;

    var row_infos: std.ArrayList(RowInfo) = .empty;
    errdefer row_infos.deinit(gpa);
    var x0: std.ArrayList(u8) = .empty;
    errdefer x0.deinit(gpa);
    var x1: std.ArrayList(u8) = .empty;
    errdefer x1.deinit(gpa);

    try row_infos.ensureTotalCapacity(gpa, row_count);

    var i: usize = 0;
    while (i < row_count) : (i += 1) {
        const r = scene.rows[i];
        if (r.bit_width == 0) {
            row_infos.appendAssumeCapacity(.{ .x0_offset = 0, .x1_offset = 0, .bytes_per_sample = 0, .segment_start = 0, .flags = 0, .y_offset = 0, .height = 0 });
            continue;
        }
        const bps = bytesPerSample(r.bit_width);
        const off0 = try packRow(&x0, gpa, r.lsbs.items);
        const off1 = try packRow(&x1, gpa, r.msbs.items);
        row_infos.appendAssumeCapacity(.{ .x0_offset = off0, .x1_offset = off1, .bytes_per_sample = bps, .segment_start = r.segment_start, .flags = 0, .y_offset = 0, .height = 0 });
    }

    // WebGPU writeBuffer needs a 4-byte-multiple size, and the shader reads the
    // pools as array<u32>; pad each tail to a word boundary with zeros (inert in
    // the OR-fold — they sit past every sample's byte run). One pad per pool, not
    // per sample, so inter-row byte offsets are unaffected.
    while (x0.items.len % 4 != 0) try x0.append(gpa, 0);
    while (x1.items.len % 4 != 0) try x1.append(gpa, 0);

    // Shader invariant: every segment's row index must point to a populated
    // RowInfo (bytes_per_sample > 0). decodeSample's loop runs bytes_per_sample
    // iterations — 0 would leave the decoded value undefined. Caught here once
    // at scene-build, not per-frame on the GPU.
    for ([_][]const PackedSegment{ scene.multi.items, scene.single.items }) |segs| {
        for (segs) |s| {
            const row = s.row_flags & 0xffff;
            std.debug.assert(row < row_infos.items.len);
            std.debug.assert(row_infos.items[row].bytes_per_sample > 0);
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
