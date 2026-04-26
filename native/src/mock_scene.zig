const std = @import("std");
const Allocator = std.mem.Allocator;
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

// Derived from V_IN_VALID / V_OUT_VALID: muted iff valid != 1.
const MUTE_IN = [_]bool{ true, true, true, false, false, true, false, false, true, true };
const MUTE_OUT = [_]bool{ true, true, true, true, true, false, false, false, false, true };

pub const Built = struct {
    multi_buf: []u8,
    single_buf: []u8,
    multi_count: u32,
    single_count: u32,
};

pub fn buildAll(gpa: Allocator) !Built {
    var multi: std.ArrayList(seg.PackedSegment) = .{};
    defer multi.deinit(gpa);
    var single: std.ArrayList(seg.PackedSegment) = .{};
    defer single.deinit(gpa);

    // Row 0: clk (bw=1) -> single
    try seg.buildClockSegments(&single, gpa, 0);

    // Row 1: rst (bw=1) -> single. Async deassert at first falling edge (tick 10).
    try seg.buildSegments(&single, gpa, 1, 1, &.{
        .{ .t_start = 0, .t_end = 10, .value = N(1) },
        .{ .t_start = 10, .t_end = seg.MOCK_END_TICKS, .value = N(0) },
    }, true);

    // Row 2: state (bw=2) -> multi
    try seg.buildDataSignal(&multi, gpa, .{ .row = 2, .bit_width = 2, .values = &V_STATE });
    // Row 3: cycle (bw=8) -> multi
    try seg.buildDataSignal(&multi, gpa, .{ .row = 3, .bit_width = 8, .values = &V_CYCLE });
    // Row 4: in_valid (bw=1) -> single
    try seg.buildDataSignal(&single, gpa, .{ .row = 4, .bit_width = 1, .values = &V_IN_VALID });
    // Row 5: in_data (bw=8) -> multi
    try seg.buildDataSignal(&multi, gpa, .{ .row = 5, .bit_width = 8, .values = &V_IN_DATA, .muted = &MUTE_IN });
    // Row 6: in_addr (bw=16) -> multi
    try seg.buildDataSignal(&multi, gpa, .{ .row = 6, .bit_width = 16, .values = &V_IN_ADDR, .muted = &MUTE_IN });
    // Row 7: out_valid (bw=1) -> single
    try seg.buildDataSignal(&single, gpa, .{ .row = 7, .bit_width = 1, .values = &V_OUT_VALID });
    // Row 8: out_data (bw=32) -> multi
    try seg.buildDataSignal(&multi, gpa, .{ .row = 8, .bit_width = 32, .values = &V_OUT_DATA, .muted = &MUTE_OUT });
    // Row 9: fifo_level (bw=4) -> multi
    try seg.buildDataSignal(&multi, gpa, .{ .row = 9, .bit_width = 4, .values = &V_FIFO_LEVEL });
    // Row 10: fifo_empty (bw=1) -> single
    try seg.buildDataSignal(&single, gpa, .{ .row = 10, .bit_width = 1, .values = &V_FIFO_EMPTY });
    // Row 11: dbus (bw=8) -> multi
    try seg.buildDataSignal(&multi, gpa, .{ .row = 11, .bit_width = 8, .values = &V_DBUS });
    // Row 12: busy (bw=1) -> single
    try seg.buildDataSignal(&single, gpa, .{ .row = 12, .bit_width = 1, .values = &V_BUSY });
    // Row 13: done (bw=1) -> single
    try seg.buildDataSignal(&single, gpa, .{ .row = 13, .bit_width = 1, .values = &V_DONE });

    const multi_count: u32 = @intCast(multi.items.len);
    const single_count: u32 = @intCast(single.items.len);

    const multi_buf = try gpa.alloc(u8, @as(usize, multi_count) * 5 * 4);
    const single_buf = try gpa.alloc(u8, @as(usize, single_count) * 5 * 4);
    seg.packInto(multi_buf, multi.items);
    seg.packInto(single_buf, single.items);

    return .{
        .multi_buf = multi_buf,
        .single_buf = single_buf,
        .multi_count = multi_count,
        .single_count = single_count,
    };
}
