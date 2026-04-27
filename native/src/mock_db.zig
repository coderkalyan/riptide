const std = @import("std");
const Allocator = std.mem.Allocator;
const tide = @import("tide");
const seg = @import("segments.zig");

const SegValue = seg.SegValue;

const X = SegValue{ .x = {} };
const Z = SegValue{ .z = {} };
fn N(v: u32) SegValue {
    return .{ .num = v };
}

const V_STATE = [_]SegValue{ X, X, N(0), N(0), N(1), N(2), N(2), N(1), N(0), N(0) };
const V_CYCLE = [_]SegValue{ X, X, N(0), N(1), N(2), N(3), N(4), N(5), N(6), N(7) };
const V_IN_VALID = [_]SegValue{ N(0), N(0), N(0), N(1), N(1), N(0), N(1), N(1), N(0), N(0) };
const V_IN_DATA = [_]SegValue{ X, X, X, N(0xA3), N(0xA3), X, N(0xB7), N(0xB7), X, X };
const V_IN_ADDR = [_]SegValue{ X, X, X, N(0x1000), N(0x1004), X, N(0x1008), N(0x100C), X, X };
const V_OUT_VALID = [_]SegValue{ N(0), N(0), N(0), N(0), N(0), N(1), N(1), N(1), N(1), N(0) };
const V_OUT_DATA = [_]SegValue{ X, X, X, X, X, N(0xDEADBEEF), N(0xDEADBEEF), N(0xCAFEB0BA), N(0xCAFEB0BA), X };
const V_FIFO_LEVEL = [_]SegValue{ X, X, N(0), N(1), N(2), N(2), N(2), N(1), N(0), N(0) };
const V_FIFO_EMPTY = [_]SegValue{ X, X, N(1), N(0), N(0), N(0), N(0), N(0), N(1), N(1) };
const V_DBUS = [_]SegValue{ X, X, Z, N(0x55), N(0x55), Z, N(0xF0), N(0xF0), Z, Z };
const V_BUSY = [_]SegValue{ N(0), N(0), N(0), N(1), N(1), N(1), N(1), N(1), N(1), N(1) };
const V_DONE = [_]SegValue{ N(0), N(0), N(0), N(0), N(0), N(0), N(0), N(0), N(1), N(0) };

pub const Row = enum(u64) {
    clk = 0,
    rst = 1,
    state = 2,
    cycle = 3,
    in_valid = 4,
    in_data = 5,
    in_addr = 6,
    out_valid = 7,
    out_data = 8,
    fifo_level = 9,
    fifo_empty = 10,
    dbus = 11,
    busy = 12,
    done = 13,
};

pub fn rowId(r: Row) tide.Signal.Id {
    return @enumFromInt(@intFromEnum(r));
}

fn writeBits(dst_x0: []u8, dst_x1: []u8, lsb: u32, msb: u32) void {
    for (dst_x0, 0..) |*b, i| b.* = @truncate(lsb >> @intCast(i * 8));
    for (dst_x1, 0..) |*b, i| b.* = @truncate(msb >> @intCast(i * 8));
}

fn appendValue(b: *tide.Builder, gpa: Allocator, ts: u64, v: SegValue, width: u32) !void {
    const bits = seg.valueBits(v, width);
    var x0 = [_]u8{0} ** 4;
    var x1 = [_]u8{0} ** 4;
    const bps = b.type.bytes();
    writeBits(x0[0..bps], x1[0..bps], bits.lsb, bits.msb);
    try b.append(gpa, ts, x0[0..bps], x1[0..bps]);
}

fn insertDataSignal(
    db: *tide.Database,
    gpa: Allocator,
    row: Row,
    width: u32,
    values: []const SegValue,
) !void {
    std.debug.assert(values.len == seg.CYCLE_DURS.len);
    const ty: tide.Type = .{ .kind = .quaternary, .width = width };
    var b: tide.Builder = .init(rowId(row), ty);
    errdefer b.deinit(gpa);

    var tick: u32 = 0;
    var i: usize = 0;
    while (i < values.len) {
        const start_tick = tick;
        var j = i;
        while (j + 1 < values.len and seg.sameValue(values[j], values[j + 1], width)) j += 1;
        try appendValue(&b, gpa, start_tick, values[i], width);
        var k = i;
        while (k <= j) : (k += 1) tick += seg.CYCLE_DURS[k] * seg.MOCK_CLOCK_TICK_NS;
        i = j + 1;
    }

    const sig = try b.build(gpa);
    try db.insert(sig);
}

fn insertClk(db: *tide.Database, gpa: Allocator) !void {
    const ty: tide.Type = .{ .kind = .quaternary, .width = 1 };
    var b: tide.Builder = .init(rowId(.clk), ty);
    errdefer b.deinit(gpa);

    const half = seg.MOCK_CLOCK_TICK_NS;
    const count = seg.MOCK_END_TICKS / half;
    var i: u32 = 0;
    while (i < count) : (i += 1) {
        const val: u8 = @intCast(i % 2);
        try b.append(gpa, i * half, &.{val}, &.{0});
    }

    const sig = try b.build(gpa);
    try db.insert(sig);
}

// Async deassert at first falling edge (tick 10).
fn insertRst(db: *tide.Database, gpa: Allocator) !void {
    const ty: tide.Type = .{ .kind = .quaternary, .width = 1 };
    var b: tide.Builder = .init(rowId(.rst), ty);
    errdefer b.deinit(gpa);

    try b.append(gpa, 0, &.{1}, &.{0});
    try b.append(gpa, 10, &.{0}, &.{0});

    const sig = try b.build(gpa);
    try db.insert(sig);
}

pub fn build(gpa: Allocator) !tide.Database {
    var db: tide.Database = .init(gpa);
    errdefer db.deinit();

    try insertClk(&db, gpa);
    try insertRst(&db, gpa);
    try insertDataSignal(&db, gpa, .state, 2, &V_STATE);
    try insertDataSignal(&db, gpa, .cycle, 8, &V_CYCLE);
    try insertDataSignal(&db, gpa, .in_valid, 1, &V_IN_VALID);
    try insertDataSignal(&db, gpa, .in_data, 8, &V_IN_DATA);
    try insertDataSignal(&db, gpa, .in_addr, 16, &V_IN_ADDR);
    try insertDataSignal(&db, gpa, .out_valid, 1, &V_OUT_VALID);
    try insertDataSignal(&db, gpa, .out_data, 32, &V_OUT_DATA);
    try insertDataSignal(&db, gpa, .fifo_level, 4, &V_FIFO_LEVEL);
    try insertDataSignal(&db, gpa, .fifo_empty, 1, &V_FIFO_EMPTY);
    try insertDataSignal(&db, gpa, .dbus, 8, &V_DBUS);
    try insertDataSignal(&db, gpa, .busy, 1, &V_BUSY);
    try insertDataSignal(&db, gpa, .done, 1, &V_DONE);

    return db;
}
