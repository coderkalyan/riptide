const std = @import("std");
const testing = std.testing;
const tide = @import("tide");
const seg = @import("segments.zig");
const mock = @import("mock_scene.zig");
const mock_db = @import("mock_db.zig");
const pack = @import("pack.zig");

const RowSpec = struct {
    row: mock_db.Row,
    width: u32,
    target: enum { multi, single },
    kind: pack.PackKind = .data,
    shaded: bool = true,
    gate: ?mock_db.Row = null,
};

const ROWS = [_]RowSpec{
    .{ .row = .clk, .width = 1, .target = .single, .kind = .clk, .shaded = false },
    .{ .row = .rst, .width = 1, .target = .single },
    .{ .row = .state, .width = 2, .target = .multi },
    .{ .row = .cycle, .width = 8, .target = .multi },
    .{ .row = .in_valid, .width = 1, .target = .single },
    .{ .row = .in_data, .width = 8, .target = .multi, .gate = .in_valid },
    .{ .row = .in_addr, .width = 16, .target = .multi, .gate = .in_valid },
    .{ .row = .out_valid, .width = 1, .target = .single },
    .{ .row = .out_data, .width = 32, .target = .multi, .gate = .out_valid },
    .{ .row = .fifo_level, .width = 4, .target = .multi },
    .{ .row = .fifo_empty, .width = 1, .target = .single },
    .{ .row = .dbus, .width = 8, .target = .multi },
    .{ .row = .busy, .width = 1, .target = .single },
    .{ .row = .done, .width = 1, .target = .single },
};

test "tide-backed pack matches legacy mock byte-for-byte" {
    const gpa = testing.allocator;

    var db = try mock_db.build(gpa);
    defer {
        for (db.signals.items) |*s| s.deinit(gpa);
        db.deinit();
    }

    var multi: std.ArrayList(seg.PackedSegment) = .{};
    defer multi.deinit(gpa);
    var single: std.ArrayList(seg.PackedSegment) = .{};
    defer single.deinit(gpa);

    for (ROWS) |r| {
        const id: tide.Signal.Id = @enumFromInt(@intFromEnum(r.row));
        const q = db.query(id, 0, seg.MOCK_END_TICKS) orelse return error.MissingSignal;
        const list = switch (r.target) {
            .multi => &multi,
            .single => &single,
        };
        try pack.packQuery(list, gpa, &db, q, .{
            .row = @intCast(@intFromEnum(r.row)),
            .width = r.width,
            .shaded = r.shaded,
            .kind = r.kind,
            .gate_id = if (r.gate) |g| @as(tide.Signal.Id, @enumFromInt(@intFromEnum(g))) else null,
        });
    }

    var legacy = try mock.buildAll(gpa);
    defer legacy.deinit(gpa);

    try testing.expectEqualSlices(seg.PackedSegment, legacy.multi.items, multi.items);
    try testing.expectEqualSlices(seg.PackedSegment, legacy.single.items, single.items);
}
