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

const MUTE_IN = [_]bool{ true, true, true, false, false, true, false, false, true, true };
const MUTE_OUT = [_]bool{ true, true, true, true, true, false, false, false, false, true };

pub const Built = struct {
    scene: seg.Scene,
    final: seg.Finalized,

    pub fn deinit(self: *Built) void {
        const gpa = self.scene.gpa;
        self.final.deinit(gpa);
        self.scene.deinit();
    }
};

pub fn buildAll(gpa: Allocator) !Built {
    var s = seg.Scene.init(gpa);
    errdefer s.deinit();

    // Row 0: clk
    try s.buildClockSegments(&s.single, 0);
    // Row 1: rst — async deassert at first falling edge.
    try s.buildSegments(&s.single, 1, 1, &.{
        .{ .t_start = 0, .t_end = 10, .value = N(1) },
        .{ .t_start = 10, .t_end = seg.MOCK_END_TICKS, .value = N(0) },
    }, true);
    try s.buildDataSignal(&s.multi, .{ .row = 2, .bit_width = 2, .values = &V_STATE });
    try s.buildDataSignal(&s.multi, .{ .row = 3, .bit_width = 8, .values = &V_CYCLE });
    try s.buildDataSignal(&s.single, .{ .row = 4, .bit_width = 1, .values = &V_IN_VALID });
    try s.buildDataSignal(&s.multi, .{ .row = 5, .bit_width = 8, .values = &V_IN_DATA, .muted = &MUTE_IN });
    try s.buildDataSignal(&s.multi, .{ .row = 6, .bit_width = 16, .values = &V_IN_ADDR, .muted = &MUTE_IN });
    try s.buildDataSignal(&s.single, .{ .row = 7, .bit_width = 1, .values = &V_OUT_VALID });
    try s.buildDataSignal(&s.multi, .{ .row = 8, .bit_width = 32, .values = &V_OUT_DATA, .muted = &MUTE_OUT });
    try s.buildDataSignal(&s.multi, .{ .row = 9, .bit_width = 4, .values = &V_FIFO_LEVEL });
    try s.buildDataSignal(&s.single, .{ .row = 10, .bit_width = 1, .values = &V_FIFO_EMPTY });
    try s.buildDataSignal(&s.multi, .{ .row = 11, .bit_width = 8, .values = &V_DBUS });
    try s.buildDataSignal(&s.single, .{ .row = 12, .bit_width = 1, .values = &V_BUSY });
    try s.buildDataSignal(&s.single, .{ .row = 13, .bit_width = 1, .values = &V_DONE });

    const final = try seg.finalize(&s, gpa);
    return .{ .scene = s, .final = final };
}
