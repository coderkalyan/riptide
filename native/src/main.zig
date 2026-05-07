const std = @import("std");
const c = @cImport({
    @cInclude("node_api.h");
});
const seg = @import("segments.zig");
const mock = @import("mock_scene.zig");

const page = std.heap.page_allocator;

fn makeArrayBufferFromSegments(env: c.napi_env, items: []const seg.PackedSegment) c.napi_value {
    const byte_len: usize = items.len * seg.PACKED_SEGMENT_BYTES;
    var data: ?*anyopaque = null;
    var result: c.napi_value = undefined;
    _ = c.napi_create_arraybuffer(env, byte_len, &data, &result);
    if (byte_len > 0) {
        const dest = @as([*]u8, @ptrCast(data.?))[0..byte_len];
        seg.packSegmentsInto(dest, items);
    }
    return result;
}

fn makeArrayBufferFromRowInfos(env: c.napi_env, items: []const seg.RowInfo) c.napi_value {
    const byte_len: usize = items.len * seg.ROW_INFO_BYTES;
    var data: ?*anyopaque = null;
    var result: c.napi_value = undefined;
    _ = c.napi_create_arraybuffer(env, byte_len, &data, &result);
    if (byte_len > 0) {
        const dest = @as([*]u8, @ptrCast(data.?))[0..byte_len];
        seg.packRowInfosInto(dest, items);
    }
    return result;
}

fn makeArrayBufferFromU32s(env: c.napi_env, words: []const u32) c.napi_value {
    const byte_len: usize = words.len * @sizeOf(u32);
    var data: ?*anyopaque = null;
    var result: c.napi_value = undefined;
    _ = c.napi_create_arraybuffer(env, byte_len, &data, &result);
    if (byte_len > 0) {
        const dest = @as([*]u8, @ptrCast(data.?))[0..byte_len];
        @memcpy(dest, std.mem.sliceAsBytes(words));
    }
    return result;
}

fn setProp(env: c.napi_env, obj: c.napi_value, name: [*c]const u8, val: c.napi_value) void {
    _ = c.napi_set_named_property(env, obj, name, val);
}

fn u32Val(env: c.napi_env, n: u32) c.napi_value {
    var v: c.napi_value = undefined;
    _ = c.napi_create_uint32(env, n, &v);
    return v;
}

fn getMockSegments(env: c.napi_env, info: c.napi_callback_info) callconv(.c) c.napi_value {
    _ = info;
    var built = mock.buildAll(page) catch @panic("buildAll failed");
    defer built.deinit();

    var obj: c.napi_value = undefined;
    _ = c.napi_create_object(env, &obj);

    const multi = makeArrayBufferFromSegments(env, built.scene.multi.items);
    const single = makeArrayBufferFromSegments(env, built.scene.single.items);
    const row_info = makeArrayBufferFromRowInfos(env, built.final.row_infos.items);
    const x0_pool = makeArrayBufferFromU32s(env, built.final.x0_pool.items);
    const x1_pool = makeArrayBufferFromU32s(env, built.final.x1_pool.items);

    setProp(env, obj, "multi", multi);
    setProp(env, obj, "multiCount", u32Val(env, @intCast(built.scene.multi.items.len)));
    setProp(env, obj, "single", single);
    setProp(env, obj, "singleCount", u32Val(env, @intCast(built.scene.single.items.len)));
    setProp(env, obj, "rowInfo", row_info);
    setProp(env, obj, "rowCount", u32Val(env, @intCast(built.final.row_infos.items.len)));
    setProp(env, obj, "x0Pool", x0_pool);
    setProp(env, obj, "x1Pool", x1_pool);
    return obj;
}

export fn napi_register_module_v1(env: c.napi_env, exports: c.napi_value) c.napi_value {
    var fn_val: c.napi_value = undefined;
    _ = c.napi_create_function(env, "getMockSegments", std.math.maxInt(usize), getMockSegments, null, &fn_val);
    _ = c.napi_set_named_property(env, exports, "getMockSegments", fn_val);
    return exports;
}
