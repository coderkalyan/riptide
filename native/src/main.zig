const std = @import("std");
const c = @cImport({
    @cInclude("node_api.h");
});
const tide = @import("tide");
const seg = @import("segments.zig");
const mock_db = @import("mock_db.zig");
const pack = @import("pack.zig");

const page = std.heap.page_allocator;

fn makeArrayBufferFromList(env: c.napi_env, items: []const seg.PackedSegment) c.napi_value {
    const byte_len: usize = items.len * seg.PACKED_SEGMENT_BYTES;
    var data: ?*anyopaque = null;
    var result: c.napi_value = undefined;
    _ = c.napi_create_arraybuffer(env, byte_len, &data, &result);
    if (byte_len > 0) {
        const dest = @as([*]u8, @ptrCast(data.?))[0..byte_len];
        seg.packInto(dest, items);
    }
    return result;
}

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

var cached_db: ?tide.Database = null;

fn getDb() *const tide.Database {
    if (cached_db == null) {
        cached_db = mock_db.build(page) catch @panic("mock_db.build failed");
    }
    return &cached_db.?;
}

fn rowId(r: mock_db.Row) tide.Signal.Id {
    return @enumFromInt(@intFromEnum(r));
}

fn buildPackedLists(gpa: std.mem.Allocator) !struct {
    multi: std.ArrayList(seg.PackedSegment),
    single: std.ArrayList(seg.PackedSegment),
} {
    var multi: std.ArrayList(seg.PackedSegment) = .{};
    errdefer multi.deinit(gpa);
    var single: std.ArrayList(seg.PackedSegment) = .{};
    errdefer single.deinit(gpa);

    const db = getDb();
    const end_t: u64 = seg.MOCK_END_TICKS;

    for (ROWS) |r| {
        const id = rowId(r.row);
        const q = db.query(id, 0, end_t) orelse @panic("missing signal");
        const list = switch (r.target) {
            .multi => &multi,
            .single => &single,
        };
        try pack.packQuery(list, gpa, db, q, .{
            .row = @intCast(@intFromEnum(r.row)),
            .width = r.width,
            .shaded = r.shaded,
            .kind = r.kind,
            .gate_id = if (r.gate) |g| rowId(g) else null,
        });
    }

    return .{ .multi = multi, .single = single };
}

fn getMockSegments(env: c.napi_env, info: c.napi_callback_info) callconv(.c) c.napi_value {
    _ = info;
    var built = buildPackedLists(page) catch @panic("buildPackedLists failed");
    defer {
        built.multi.deinit(page);
        built.single.deinit(page);
    }

    var obj: c.napi_value = undefined;
    _ = c.napi_create_object(env, &obj);

    const multi = makeArrayBufferFromList(env, built.multi.items);
    const single = makeArrayBufferFromList(env, built.single.items);

    var mc: c.napi_value = undefined;
    var sc: c.napi_value = undefined;
    _ = c.napi_create_uint32(env, @intCast(built.multi.items.len), &mc);
    _ = c.napi_create_uint32(env, @intCast(built.single.items.len), &sc);

    _ = c.napi_set_named_property(env, obj, "multi", multi);
    _ = c.napi_set_named_property(env, obj, "multiCount", mc);
    _ = c.napi_set_named_property(env, obj, "single", single);
    _ = c.napi_set_named_property(env, obj, "singleCount", sc);
    return obj;
}

export fn napi_register_module_v1(env: c.napi_env, exports: c.napi_value) c.napi_value {
    var fn_val: c.napi_value = undefined;
    _ = c.napi_create_function(env, "getMockSegments", std.math.maxInt(usize), getMockSegments, null, &fn_val);
    _ = c.napi_set_named_property(env, exports, "getMockSegments", fn_val);
    return exports;
}
