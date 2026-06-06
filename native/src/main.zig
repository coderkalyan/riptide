const std = @import("std");
const c = @cImport({
    @cInclude("node_api.h");
});
const tide = @import("tide");
const seg = @import("segments.zig");
const mock_db = @import("mock_db.zig");
const pack = @import("pack.zig");
const hier = @import("hier.zig");
const label = @import("label.zig");

const page = std.heap.page_allocator;

// ---- ArrayBuffer helpers ------------------------------------------------
// V8's sandbox in Electron rejects external pointers, so we allocate via
// napi_create_arraybuffer (V8 owns the store) and memcpy our packed bytes in.

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

fn makeArrayBufferFromU8s(env: c.napi_env, bytes: []const u8) c.napi_value {
    var data: ?*anyopaque = null;
    var result: c.napi_value = undefined;
    _ = c.napi_create_arraybuffer(env, bytes.len, &data, &result);
    if (bytes.len > 0) {
        const dest = @as([*]u8, @ptrCast(data.?))[0..bytes.len];
        @memcpy(dest, bytes);
    }
    return result;
}

// ---- small napi value helpers ------------------------------------------

fn setProp(env: c.napi_env, obj: c.napi_value, name: [*:0]const u8, val: c.napi_value) void {
    _ = c.napi_set_named_property(env, obj, name, val);
}

fn jsU32(env: c.napi_env, n: u32) c.napi_value {
    var v: c.napi_value = undefined;
    _ = c.napi_create_uint32(env, n, &v);
    return v;
}

// A JS number from a u64 tick. Ticks are tide-native u64; JS numbers are exact
// to 2^53, which covers every realistic timestamp. Used for endTicks (the
// renderer's fit window / clamps) — must NOT be narrowed to u32 (the old cap).
fn jsTick(env: c.napi_env, n: u64) c.napi_value {
    var v: c.napi_value = undefined;
    _ = c.napi_create_double(env, @floatFromInt(n), &v);
    return v;
}

// Read a JS number as a u64 tick (clamped non-negative). napi_get_value_int64
// preserves the full 53-bit-exact integer range — unlike napi_get_value_uint32,
// whose 2^32 cap was the old GPU/napi tick ceiling.
fn readTick(env: c.napi_env, v: c.napi_value) u64 {
    var n: i64 = 0;
    if (c.napi_get_value_int64(env, v, &n) != c.napi_ok) return 0;
    return if (n < 0) 0 else @intCast(n);
}

// A JS array of `words` u32s read little-endian from `bytes` (tide's per-sample
// byte run), zero-padded when shorter. The CPU value path (getValueAt) keeps this
// word-array shape for formatSegmentValue; it's independent of the GPU pools, which
// now carry tide's bytes verbatim (no word repack — see TIDE_INTEGRATION.md §2.2).
fn jsWordArray(env: c.napi_env, bytes: []const u8, words: u32) c.napi_value {
    const arr = jsArr(env, words);
    var w: u32 = 0;
    while (w < words) : (w += 1) {
        var word: u32 = 0;
        var b: u32 = 0;
        while (b < 4) : (b += 1) {
            const idx = w * 4 + b;
            if (idx < bytes.len) word |= @as(u32, bytes[idx]) << @intCast(b * 8);
        }
        _ = c.napi_set_element(env, arr, w, jsU32(env, word));
    }
    return arr;
}

fn jsStr(env: c.napi_env, s: []const u8) c.napi_value {
    var v: c.napi_value = undefined;
    _ = c.napi_create_string_utf8(env, s.ptr, s.len, &v);
    return v;
}

fn jsNull(env: c.napi_env) c.napi_value {
    var r: c.napi_value = undefined;
    _ = c.napi_get_null(env, &r);
    return r;
}

fn jsUndefined(env: c.napi_env) c.napi_value {
    var r: c.napi_value = undefined;
    _ = c.napi_get_undefined(env, &r);
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

// ---- cached tide state --------------------------------------------------

// The current trace's parsed scene (db + hierarchy), set by loadVcd and reused
// across napi calls. loadVcd must run before any query (the renderer calls it at
// startup with the trace path from the window URL).
var cached: ?mock_db.Loaded = null;

fn getLoaded() *const mock_db.Loaded {
    if (cached == null) @panic("getLoaded: loadVcd must be called before querying");
    return &cached.?;
}

fn getDb() *const tide.Database {
    return &getLoaded().db;
}

fn getHier() *const hier.Hierarchy {
    return &getLoaded().hierarchy;
}

// loadVcd(path: string): parse `path` and make it the current trace. Throws a JS
// error (rather than crashing) on a missing/unparseable file, leaving any
// previously loaded trace intact.
fn loadVcd(env: c.napi_env, info: c.napi_callback_info) callconv(.c) c.napi_value {
    var argc: usize = 1;
    var argv: [1]c.napi_value = undefined;
    _ = c.napi_get_cb_info(env, info, &argc, &argv, null, null);
    if (argc < 1) {
        _ = c.napi_throw_error(env, null, "loadVcd: missing path argument");
        return jsUndefined(env);
    }
    var buf: [4096]u8 = undefined;
    var len: usize = 0;
    if (c.napi_get_value_string_utf8(env, argv[0], &buf, buf.len, &len) != c.napi_ok) {
        _ = c.napi_throw_error(env, null, "loadVcd: path is not a string");
        return jsUndefined(env);
    }
    const loaded = mock_db.load(page, buf[0..len]) catch |e| {
        var msg: [512]u8 = undefined;
        const m: [:0]const u8 = std.fmt.bufPrintZ(&msg, "loadVcd failed for '{s}': {s}", .{ buf[0..len], @errorName(e) }) catch "loadVcd failed";
        _ = c.napi_throw_error(env, null, m.ptr);
        return jsUndefined(env);
    };
    // Swap only on success so a bad open leaves the prior trace intact.
    if (cached) |*old| old.deinit();
    cached = loaded;
    return jsUndefined(env);
}

// ---- getMockSegments ----------------------------------------------------

const PackSpec = struct {
    row: u32,
    handle: tide.Signal.Id,
    kind: pack.PackKind,
    polarity: pack.ClockPolarity,
    shaded: bool,
    gate: ?tide.Signal.Id,
    radix: label.Radix,
    enums: []const label.EnumEntry,
};

fn parseHandle(env: c.napi_env, v: c.napi_value) ?tide.Signal.Id {
    var buf: [32]u8 = undefined;
    var len: usize = 0;
    if (c.napi_get_value_string_utf8(env, v, &buf, buf.len, &len) != c.napi_ok) return null;
    const id_int = std.fmt.parseInt(u64, buf[0..len], 10) catch return null;
    return @enumFromInt(id_int);
}

// Parse the per-row enum int→label table ([{ value, label }]) into arena-owned
// EnumEntry slices. Labels are copied so they outlive the napi scope (formatValue
// only borrows them during packing). Returns an empty slice when absent.
fn parseEnums(env: c.napi_env, v: c.napi_value, arena: std.mem.Allocator) []const label.EnumEntry {
    var enums_v: c.napi_value = undefined;
    if (c.napi_get_named_property(env, v, "enums", &enums_v) != c.napi_ok) return &.{};
    var vt: c.napi_valuetype = undefined;
    _ = c.napi_typeof(env, enums_v, &vt);
    if (vt != c.napi_object) return &.{};
    var elen: u32 = 0;
    if (c.napi_get_array_length(env, enums_v, &elen) != c.napi_ok or elen == 0) return &.{};

    const out = arena.alloc(label.EnumEntry, elen) catch return &.{};
    var k: u32 = 0;
    while (k < elen) : (k += 1) {
        var ev: c.napi_value = undefined;
        _ = c.napi_get_element(env, enums_v, k, &ev);
        var val_v: c.napi_value = undefined;
        var lab_v: c.napi_value = undefined;
        _ = c.napi_get_named_property(env, ev, "value", &val_v);
        _ = c.napi_get_named_property(env, ev, "label", &lab_v);
        var val: u32 = 0;
        _ = c.napi_get_value_uint32(env, val_v, &val);
        var slen: usize = 0;
        _ = c.napi_get_value_string_utf8(env, lab_v, null, 0, &slen);
        const sbuf = arena.alloc(u8, slen + 1) catch return out[0..k];
        var written: usize = 0;
        _ = c.napi_get_value_string_utf8(env, lab_v, sbuf.ptr, sbuf.len, &written);
        out[k] = .{ .value = val, .label = sbuf[0..written] };
    }
    return out;
}

fn parseSpec(env: c.napi_env, v: c.napi_value, arena: std.mem.Allocator) ?PackSpec {
    var row_v: c.napi_value = undefined;
    var handle_v: c.napi_value = undefined;
    var kind_v: c.napi_value = undefined;
    var shaded_v: c.napi_value = undefined;
    var gate_v: c.napi_value = undefined;
    if (c.napi_get_named_property(env, v, "row", &row_v) != c.napi_ok) return null;
    if (c.napi_get_named_property(env, v, "handle", &handle_v) != c.napi_ok) return null;
    if (c.napi_get_named_property(env, v, "kind", &kind_v) != c.napi_ok) return null;
    if (c.napi_get_named_property(env, v, "shaded", &shaded_v) != c.napi_ok) return null;
    if (c.napi_get_named_property(env, v, "gateHandle", &gate_v) != c.napi_ok) return null;

    var row: u32 = 0;
    if (c.napi_get_value_uint32(env, row_v, &row) != c.napi_ok) return null;

    const handle = parseHandle(env, handle_v) orelse return null;

    var kind_buf: [8]u8 = undefined;
    var kind_len: usize = 0;
    if (c.napi_get_value_string_utf8(env, kind_v, &kind_buf, kind_buf.len, &kind_len) != c.napi_ok) return null;
    const kind: pack.PackKind = if (std.mem.eql(u8, kind_buf[0..kind_len], "clk")) .clk else .data;

    // polarity: optional string, defaults to rising (clk kind only; ignored for
    // data). Picks which clock edges get a chevron.
    var polarity: pack.ClockPolarity = .rising;
    var pol_v: c.napi_value = undefined;
    if (c.napi_get_named_property(env, v, "polarity", &pol_v) == c.napi_ok) {
        var pbuf: [8]u8 = undefined;
        var plen: usize = 0;
        if (c.napi_get_value_string_utf8(env, pol_v, &pbuf, pbuf.len, &plen) == c.napi_ok) {
            const ps = pbuf[0..plen];
            polarity = if (std.mem.eql(u8, ps, "falling")) .falling else if (std.mem.eql(u8, ps, "both")) .both else .rising;
        }
    }

    var shaded: bool = false;
    if (c.napi_get_value_bool(env, shaded_v, &shaded) != c.napi_ok) return null;

    var gate_type: c.napi_valuetype = undefined;
    _ = c.napi_typeof(env, gate_v, &gate_type);
    const gate: ?tide.Signal.Id = if (gate_type == c.napi_string) parseHandle(env, gate_v) else null;

    // radix: optional string, defaults to bin (matches makeActiveRef scalars).
    var radix: label.Radix = .bin;
    var radix_v: c.napi_value = undefined;
    if (c.napi_get_named_property(env, v, "radix", &radix_v) == c.napi_ok) {
        var rbuf: [8]u8 = undefined;
        var rlen: usize = 0;
        if (c.napi_get_value_string_utf8(env, radix_v, &rbuf, rbuf.len, &rlen) == c.napi_ok) {
            const rs = rbuf[0..rlen];
            radix = if (std.mem.eql(u8, rs, "hex")) .hex else if (std.mem.eql(u8, rs, "dec")) .dec else if (std.mem.eql(u8, rs, "sdec")) .sdec else if (std.mem.eql(u8, rs, "enum")) .@"enum" else .bin;
        }
    }

    return .{ .row = row, .handle = handle, .kind = kind, .polarity = polarity, .shaded = shaded, .gate = gate, .radix = radix, .enums = parseEnums(env, v, arena) };
}

// getMockSegments(specs, qStart, qEnd): pack each active signal over the tick
// window [qStart, qEnd]. The window is the visible viewport plus an over-fetch
// margin (renderer side); packing is ephemeral — repacked on every viewport
// change that exits the packed range. Cost is O(window): tide's db.query is a
// binary-search slice that also returns the sample active at qStart (so the
// left-edge segment is drawn from offscreen, identical to a full-range pack).
// The half-open right edge means the last in-window segment's t_end snaps to
// end_t; the renderer's margin keeps that segment offscreen so it's never seen.
fn getMockSegments(env: c.napi_env, info: c.napi_callback_info) callconv(.c) c.napi_value {
    var argc: usize = 3;
    var argv: [3]c.napi_value = undefined;
    _ = c.napi_get_cb_info(env, info, &argc, &argv, null, null);
    if (argc < 3) @panic("getMockSegments: expected (specs, qStart, qEnd)");

    var arr_len: u32 = 0;
    _ = c.napi_get_array_length(env, argv[0], &arr_len);

    const loaded = getLoaded();
    const db = &loaded.db;
    const end_t: u64 = loaded.end_t;

    var q_start: u64 = readTick(env, argv[1]);
    var q_end: u64 = readTick(env, argv[2]);
    if (q_end > end_t) q_end = end_t;
    if (q_start > q_end) q_start = q_end;

    // Scratch arena for per-spec enum tables parsed out of the JS specs (the
    // label strings must outlive parseSpec). Freed when this call returns.
    var arena = std.heap.ArenaAllocator.init(page);
    defer arena.deinit();

    var scene = seg.Scene.init(page);
    defer scene.deinit();

    var i: u32 = 0;
    while (i < arr_len) : (i += 1) {
        var elem: c.napi_value = undefined;
        _ = c.napi_get_element(env, argv[0], i, &elem);
        const s = parseSpec(env, elem, arena.allocator()) orelse @panic("invalid spec");

        // Windowed query + pack, fresh each call (no cache — the packed output is
        // viewport-dependent now, so a per-signal cache keyed on config would never
        // hit across pans). packSignal owns its allocations; deinit after placement.
        const q = db.query(s.handle, q_start, q_end) orelse @panic("missing signal");
        var ps = pack.packSignal(page, db, q, .{
            .width = q.type.width,
            .shaded = s.shaded,
            .end_t = end_t,
            .kind = s.kind,
            .polarity = s.polarity,
            .gate_id = s.gate,
            .radix = s.radix,
            .enums = s.enums,
        }) catch @panic("packSignal failed");
        defer ps.deinit(page);

        // 1-bit signals render as lines (single pipeline); wider ones as pills
        // (multi pipeline). Mirrors mock_scene's row/target assignment.
        const target = if (ps.is_multi) &scene.multi else &scene.single;
        scene.pushPackedSignal(target, s.row, &ps) catch @panic("pushPackedSignal failed");
    }

    var final = seg.finalize(&scene, page) catch @panic("finalize failed");
    defer final.deinit(page);

    const obj = jsObj(env);
    setProp(env, obj, "multi", makeArrayBufferFromSegments(env, scene.multi.items));
    setProp(env, obj, "multiCount", jsU32(env, @intCast(scene.multi.items.len)));
    setProp(env, obj, "single", makeArrayBufferFromSegments(env, scene.single.items));
    setProp(env, obj, "singleCount", jsU32(env, @intCast(scene.single.items.len)));
    setProp(env, obj, "rowInfo", makeArrayBufferFromRowInfos(env, final.row_infos.items));
    setProp(env, obj, "rowCount", jsU32(env, @intCast(final.row_infos.items.len)));
    // Byte-stride value pools (tide's native per-sample byte runs, padded to a
    // 4-byte multiple in finalize so writeBuffer accepts them). Bound as
    // array<u32> on the GPU and byte-addressed by decodeSample.
    setProp(env, obj, "x0Pool", makeArrayBufferFromU8s(env, final.x0_pool.items));
    setProp(env, obj, "x1Pool", makeArrayBufferFromU8s(env, final.x1_pool.items));
    // Native value labels, aligned with `multi` (label i = bytes[off[i]..off[i+1]]).
    setProp(env, obj, "labelBytes", makeArrayBufferFromU8s(env, scene.multi_label_bytes.items));
    setProp(env, obj, "labelOffsets", makeArrayBufferFromU32s(env, scene.multi_label_offsets.items));
    // The trace's true end tick (last ingested timestamp). The renderer needs the
    // real end for viewport clamps / the zoom-out dead-zone, not a hardcoded mock.
    setProp(env, obj, "endTicks", jsTick(env, end_t));
    return obj;
}

// ---- getValueAt ---------------------------------------------------------

fn getValueAt(env: c.napi_env, info: c.napi_callback_info) callconv(.c) c.napi_value {
    var argc: usize = 2;
    var argv: [2]c.napi_value = undefined;
    _ = c.napi_get_cb_info(env, info, &argc, &argv, null, null);
    if (argc < 2) return jsNull(env);

    const id = parseHandle(env, argv[0]) orelse return jsNull(env);

    const tick = readTick(env, argv[1]);

    const v = pack.valueAt(getDb(), id, tick) orelse return jsNull(env);

    const words = seg.wordsPerSample(v.width);
    const o = jsObj(env);
    setProp(env, o, "lsb", jsWordArray(env, v.x0, words));
    setProp(env, o, "msb", jsWordArray(env, v.x1, words));
    return o;
}

// ---- getEdges -----------------------------------------------------------
// Returns up to `count` transitions of a signal at/after `startTick`, for cheap
// prefix reads (clock period/phase + reset-band detection on the renderer side).
// Each transition yields its tick plus the LOW byte of its x0/x1 planes — enough
// to decode the (msb,lsb) logic level of 1-bit clock/reset signals, which is all
// the consumers need.
fn getEdges(env: c.napi_env, info: c.napi_callback_info) callconv(.c) c.napi_value {
    var argc: usize = 3;
    var argv: [3]c.napi_value = undefined;
    _ = c.napi_get_cb_info(env, info, &argc, &argv, null, null);
    if (argc < 3) return jsNull(env);

    const id = parseHandle(env, argv[0]) orelse return jsNull(env);

    const start_tick = readTick(env, argv[1]);
    var count: u32 = 0;
    if (c.napi_get_value_uint32(env, argv[2], &count) != c.napi_ok) return jsNull(env);

    const q = getDb().queryNext(id, start_tick, count) orelse return jsNull(env);
    const n: usize = @intCast(q.len);
    const bps = q.type.bytes();

    // ticks (f64 each — full u64 range, exact to 2^53) + lsb/msb (one byte per
    // transition: the sample's low byte).
    var ticks: c.napi_value = undefined;
    var ticks_data: ?*anyopaque = null;
    _ = c.napi_create_arraybuffer(env, n * @sizeOf(f64), &ticks_data, &ticks);
    var lsb: c.napi_value = undefined;
    var lsb_data: ?*anyopaque = null;
    _ = c.napi_create_arraybuffer(env, n, &lsb_data, &lsb);
    var msb: c.napi_value = undefined;
    var msb_data: ?*anyopaque = null;
    _ = c.napi_create_arraybuffer(env, n, &msb_data, &msb);
    if (n > 0) {
        const tdst = @as([*]f64, @ptrCast(@alignCast(ticks_data.?)))[0..n];
        const ldst = @as([*]u8, @ptrCast(lsb_data.?))[0..n];
        const mdst = @as([*]u8, @ptrCast(msb_data.?))[0..n];
        var i: usize = 0;
        while (i < n) : (i += 1) {
            tdst[i] = @floatFromInt(q.timestamps[i]);
            ldst[i] = q.x0s[i * bps];
            mdst[i] = q.x1s[i * bps];
        }
    }

    const o = jsObj(env);
    setProp(env, o, "ticks", ticks);
    setProp(env, o, "lsb", lsb);
    setProp(env, o, "msb", msb);
    setProp(env, o, "count", jsU32(env, @intCast(n)));
    return o;
}

// ---- getHierarchy -------------------------------------------------------

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

    const tsv = getLoaded().timescale;
    const ts = jsObj(env);
    setProp(env, ts, "value", jsU32(env, tsv.value));
    setProp(env, ts, "unit", jsStr(env, tsv.unit));
    setProp(env, root, "timescale", ts);

    // Trace's true end tick (last ingested timestamp) — the renderer's source of
    // truth for the fit window / clamps / zoom-out dead-zone (replaces the old
    // hardcoded mock end). Resolved once at scene build, before any frame.
    setProp(env, root, "endTicks", jsTick(env, getLoaded().end_t));

    return root;
}

// ---- module registration ------------------------------------------------

fn registerFn(env: c.napi_env, exports: c.napi_value, name: [*:0]const u8, cb: c.napi_callback) void {
    var fn_val: c.napi_value = undefined;
    _ = c.napi_create_function(env, name, std.math.maxInt(usize), cb, null, &fn_val);
    _ = c.napi_set_named_property(env, exports, name, fn_val);
}

export fn napi_register_module_v1(env: c.napi_env, exports: c.napi_value) c.napi_value {
    registerFn(env, exports, "loadVcd", loadVcd);
    registerFn(env, exports, "getMockSegments", getMockSegments);
    registerFn(env, exports, "getHierarchy", getHierarchy);
    registerFn(env, exports, "getValueAt", getValueAt);
    registerFn(env, exports, "getEdges", getEdges);
    return exports;
}
