const std = @import("std");
const c = @cImport({
    @cInclude("node_api.h");
});
const tide = @import("tide");
const seg = @import("segments.zig");
const mock_db = @import("mock_db.zig");
const pack = @import("pack.zig");
const hier = @import("hier.zig");

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
var cached_hier: ?hier.Hierarchy = null;

fn getDb() *const tide.Database {
    if (cached_db == null) {
        cached_db = mock_db.build(page) catch @panic("mock_db.build failed");
    }
    return &cached_db.?;
}

fn getHier() *const hier.Hierarchy {
    if (cached_hier == null) {
        cached_hier = mock_db.buildHierarchy(page) catch @panic("buildHierarchy failed");
    }
    return &cached_hier.?;
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
        const q = db.query(mock_db.rowId(r.row), 0, end_t) orelse @panic("missing signal");
        const list = switch (r.target) {
            .multi => &multi,
            .single => &single,
        };
        try pack.packQuery(list, gpa, db, q, .{
            .row = @intCast(@intFromEnum(r.row)),
            .width = r.width,
            .shaded = r.shaded,
            .kind = r.kind,
            .gate_id = if (r.gate) |g| mock_db.rowId(g) else null,
        });
    }

    return .{ .multi = multi, .single = single };
}

fn jsStr(env: c.napi_env, s: []const u8) c.napi_value {
    var v: c.napi_value = undefined;
    _ = c.napi_create_string_utf8(env, s.ptr, s.len, &v);
    return v;
}

fn jsU32(env: c.napi_env, v: u32) c.napi_value {
    var r: c.napi_value = undefined;
    _ = c.napi_create_uint32(env, v, &r);
    return r;
}

fn jsNull(env: c.napi_env) c.napi_value {
    var r: c.napi_value = undefined;
    _ = c.napi_get_null(env, &r);
    return r;
}

fn jsArr(env: c.napi_env, len: u32) c.napi_value {
    var r: c.napi_value = undefined;
    _ = c.napi_create_array_with_length(env, len, &r);
    return r;
}

fn jsObj(env: c.napi_env) c.napi_value {
    var r: c.napi_value = undefined;
    _ = c.napi_create_object(env, &r);
    return r;
}

fn jsHandle(env: c.napi_env, id: tide.Signal.Id) c.napi_value {
    var buf: [21]u8 = undefined;
    const s = std.fmt.bufPrint(&buf, "{d}", .{@intFromEnum(id)}) catch unreachable;
    return jsStr(env, s);
}

fn setProp(env: c.napi_env, obj: c.napi_value, name: [*:0]const u8, val: c.napi_value) void {
    _ = c.napi_set_named_property(env, obj, name, val);
}

fn scopeTypeStr(t: hier.ScopeType) []const u8 {
    return switch (t) {
        .module => "module",
        .task => "task",
        .function => "function",
        .begin => "begin",
        .fork => "fork",
        .generate => "generate",
        .struct_ => "struct",
        .union_ => "union",
        .class_ => "class",
        .interface_ => "interface",
        .package => "package",
        .program => "program",
    };
}

fn varTypeStr(t: hier.VarType) []const u8 {
    return switch (t) {
        .vcd_wire => "vcd_wire",
        .vcd_reg => "vcd_reg",
    };
}

fn directionStr(d: hier.Direction) []const u8 {
    return switch (d) {
        .implicit => "implicit",
        .input => "input",
        .output => "output",
        .inout => "inout",
        .buffer => "buffer",
        .linkage => "linkage",
    };
}

fn buildNodeObj(env: c.napi_env, n: hier.Node) c.napi_value {
    const o = jsObj(env);
    setProp(env, o, "id", jsU32(env, n.id));
    setProp(env, o, "parent", if (n.parent) |p| jsU32(env, p) else jsNull(env));
    setProp(env, o, "name", jsStr(env, n.name));
    switch (n.payload) {
        .scope => |s| {
            setProp(env, o, "kind", jsStr(env, "scope"));
            setProp(env, o, "scopeType", jsStr(env, scopeTypeStr(s.scope_type)));
            const ch = jsArr(env, @intCast(s.children.items.len));
            for (s.children.items, 0..) |child_id, i| {
                _ = c.napi_set_element(env, ch, @intCast(i), jsU32(env, child_id));
            }
            setProp(env, o, "children", ch);
        },
        .signal => |s| {
            setProp(env, o, "kind", jsStr(env, "signal"));
            setProp(env, o, "varType", jsStr(env, varTypeStr(s.var_type)));
            setProp(env, o, "direction", jsStr(env, directionStr(s.direction)));
            setProp(env, o, "bitWidth", jsU32(env, s.bit_width));
            setProp(env, o, "handle", jsHandle(env, s.handle));
        },
    }
    return o;
}

fn getHierarchy(env: c.napi_env, info: c.napi_callback_info) callconv(.c) c.napi_value {
    _ = info;
    const h = getHier();

    const root = jsObj(env);

    const root_ids = jsArr(env, @intCast(h.root_ids.items.len));
    for (h.root_ids.items, 0..) |id, i| {
        _ = c.napi_set_element(env, root_ids, @intCast(i), jsU32(env, id));
    }
    setProp(env, root, "rootIds", root_ids);

    const nodes = jsArr(env, @intCast(h.nodes.items.len));
    for (h.nodes.items, 0..) |n, i| {
        _ = c.napi_set_element(env, nodes, @intCast(i), buildNodeObj(env, n));
    }
    setProp(env, root, "nodes", nodes);

    setProp(env, root, "format", jsStr(env, "unknown"));

    const ts = jsObj(env);
    setProp(env, ts, "value", jsU32(env, 1));
    setProp(env, ts, "unit", jsStr(env, "ns"));
    setProp(env, root, "timescale", ts);

    return root;
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

fn registerFn(env: c.napi_env, exports: c.napi_value, name: [*:0]const u8, cb: c.napi_callback) void {
    var fn_val: c.napi_value = undefined;
    _ = c.napi_create_function(env, name, std.math.maxInt(usize), cb, null, &fn_val);
    _ = c.napi_set_named_property(env, exports, name, fn_val);
}

export fn napi_register_module_v1(env: c.napi_env, exports: c.napi_value) c.napi_value {
    registerFn(env, exports, "getMockSegments", getMockSegments);
    registerFn(env, exports, "getHierarchy", getHierarchy);
    return exports;
}
