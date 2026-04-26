const std = @import("std");
const c = @cImport({
    @cInclude("node_api.h");
});
const mock = @import("mock_scene.zig");

const page = std.heap.page_allocator;

fn finalize_cb(env: c.napi_env, data: ?*anyopaque, hint: ?*anyopaque) callconv(.c) void {
    _ = env;
    _ = data;
    const slice_ptr: *[]u8 = @ptrCast(@alignCast(hint));
    const sl = slice_ptr.*;
    page.free(sl);
    page.destroy(slice_ptr);
}

fn makeExternalArrayBuffer(env: c.napi_env, buf: []u8) c.napi_value {
    const hint = page.create([]u8) catch @panic("alloc failed");
    hint.* = buf;
    var result: c.napi_value = undefined;
    _ = c.napi_create_external_arraybuffer(env, buf.ptr, buf.len, finalize_cb, @ptrCast(hint), &result);
    return result;
}

fn getMockSegments(env: c.napi_env, info: c.napi_callback_info) callconv(.c) c.napi_value {
    _ = info;
    const built = mock.buildAll(page) catch @panic("buildAll failed");

    var obj: c.napi_value = undefined;
    _ = c.napi_create_object(env, &obj);

    const multi = makeExternalArrayBuffer(env, built.multi_buf);
    const single = makeExternalArrayBuffer(env, built.single_buf);

    var mc: c.napi_value = undefined;
    var sc: c.napi_value = undefined;
    _ = c.napi_create_uint32(env, built.multi_count, &mc);
    _ = c.napi_create_uint32(env, built.single_count, &sc);

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
