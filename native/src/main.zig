const std = @import("std");
const c = @cImport({
    @cInclude("node_api.h");
});
const seg = @import("segments.zig");
const mock = @import("mock_scene.zig");

const page = std.heap.page_allocator;

// V8 sandbox in Electron rejects external pointers from outside its heap, so
// `napi_create_external_arraybuffer` SIGSEGVs there. Use `napi_create_arraybuffer`
// instead — V8 owns the backing store, we get a writable pointer to fill in.
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

fn getMockSegments(env: c.napi_env, info: c.napi_callback_info) callconv(.c) c.napi_value {
    _ = info;
    var built = mock.buildAll(page) catch @panic("buildAll failed");
    defer built.deinit(page);

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
