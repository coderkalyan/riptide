const std = @import("std");
const Allocator = std.mem.Allocator;
const tide = @import("tide");
const tide_vcd = @import("tide_vcd");
const hier = @import("hier.zig");

// The scene is loaded from a VCD file on disk (path supplied by JS — the bundled
// native/src/mock.vcd by default, or a user-opened file). We parse it with
// tide-vcd, mirror its hierarchy into hier.Hierarchy, and stream its
// value-change events into a tide.Database. Regenerate the bundled fixture with
// native/scripts/gen_mock_vcd.py.

// Everything produced from one parse of the fixture. Both the renderer's
// segment queries and its SignalTree read from this; it is built once and cached
// (see main.zig).
pub const Loaded = struct {
    db: tide.Database,
    hierarchy: hier.Hierarchy,
    /// Right boundary of the trace (max timestamp seen). The last segment of
    /// every signal extends to here, matching the old MOCK_END_TICKS.
    end_t: u32,

    pub fn deinit(self: *Loaded) void {
        self.db.deinit();
        self.hierarchy.deinit();
    }
};

// ---- value decoding -----------------------------------------------------
// tide stores 4-state values as (x1,x0) bit planes: 00=0 01=1 10=x 11=z, which
// is exactly riptide's (msb,lsb) convention. h/l/u/w/- and any other extended
// logic value collapse to x (documented shim — see TIDE_INTEGRATION.md).
//
// Widths are arbitrary: real traces carry 64-bit (and wider — buses of hundreds
// of bits) signals, so values are written straight into width-sized byte buffers
// (one bit per signal bit, LSB-first within each plane) rather than a 32-bit
// accumulator. The GPU pool still only renders ≤32-bit rows, but the database
// must store every signal at full width so the trace opens and the tree/values
// are correct.

// Largest signal width (bytes) we ingest; vectors beyond this are rejected
// rather than overflowing the stack buffers. 1024 B = 8192-bit signals.
const MAX_VALUE_BYTES: usize = 1024;

const LogicBit = struct { lsb: bool, msb: bool };

fn charBit(c: u8) LogicBit {
    return switch (c) {
        '0' => .{ .lsb = false, .msb = false },
        '1' => .{ .lsb = true, .msb = false },
        'z', 'Z' => .{ .lsb = true, .msb = true },
        else => .{ .lsb = false, .msb = true }, // x/X and extended values
    };
}

fn setBit(buf: []u8, i: usize, v: bool) void {
    if (v) buf[i >> 3] |= @as(u8, 1) << @intCast(i & 7);
}

// 1-bit scalar change: one byte per plane.
fn appendScalar(b: *tide.Builder, gpa: Allocator, ts: u64, value: u8) !void {
    const lm = charBit(value);
    try b.append(gpa, ts, &[_]u8{@intFromBool(lm.lsb)}, &[_]u8{@intFromBool(lm.msb)});
}

// MSB-first VCD vector, left-extended to the declared width per the VCD rule
// (pad '0' for 0/1-leading values, else the leading x/z char).
fn appendVector(b: *tide.Builder, gpa: Allocator, ts: u64, value: []const u8, width: u32) !void {
    const bps = b.type.bytes();
    if (bps > MAX_VALUE_BYTES) return error.SignalTooWide;
    var x0: [MAX_VALUE_BYTES]u8 = undefined;
    var x1: [MAX_VALUE_BYTES]u8 = undefined;
    @memset(x0[0..bps], 0);
    @memset(x1[0..bps], 0);
    const lead = if (value.len > 0) value[0] else '0';
    const pad: u8 = if (lead == '0' or lead == '1') '0' else lead;
    var i: usize = 0;
    while (i < width) : (i += 1) {
        // Bit i (LSB = 0) is the i-th char from the right of the MSB-first
        // string, or the pad char once we run past its length.
        const c: u8 = if (i < value.len) value[value.len - 1 - i] else pad;
        const lm = charBit(c);
        setBit(x0[0..bps], i, lm.lsb);
        setBit(x1[0..bps], i, lm.msb);
    }
    try b.append(gpa, ts, x0[0..bps], x1[0..bps]);
}

// ---- hierarchy mapping --------------------------------------------------

fn mapScopeType(t: tide_vcd.Hierarchy.Scope.Type) hier.ScopeType {
    return switch (t) {
        .module => .module,
        .task => .task,
        .function => .function,
        .begin => .begin,
        .fork => .fork,
    };
}

fn mapVarType(t: tide_vcd.Hierarchy.Var.Type) hier.VarType {
    return switch (t) {
        .reg, .integer, .time, .trireg => .vcd_reg,
        else => .vcd_wire,
    };
}

// Recursively mirror the parsed VCD scope subtree rooted at `scope_id` into the
// hierarchy builder, recording each var's width by its tide signal id. Vars are
// emitted before child scopes, matching their declaration order in the fixture.
fn walkInto(
    p: *const tide_vcd.Parser,
    hb: *hier.Builder,
    widths: []u32,
    scope_id: tide_vcd.Hierarchy.Scope.Id,
) !void {
    var vit = p.childVars(scope_id);
    while (vit.next()) |v| {
        const sid: u64 = @intFromEnum(p.symbol_table.get(&p.string_pool, v.ascii_id));
        if (sid < widths.len) widths[sid] = v.size;
        _ = try hb.addSignal(.{
            .name = v.name,
            .var_type = mapVarType(v.type),
            .bit_width = v.size,
            .handle = @enumFromInt(sid),
        });
    }
    var sit = p.childScopes(scope_id);
    while (sit.next()) |s| {
        _ = try hb.openScope(s.local_id, mapScopeType(s.type));
        try walkInto(p, hb, widths, s.id);
        hb.closeScope();
    }
}

pub fn load(gpa: Allocator, path: []const u8) !Loaded {
    // Read the whole VCD into a NUL-terminated buffer (tide-vcd's Parser borrows
    // the body/date/version slices, so it must outlive the parser — freed below
    // after load completes and the db/hierarchy own copies of everything).
    const io = std.Io.Threaded.global_single_threaded.io();
    const data = try std.Io.Dir.cwd().readFileAllocOptions(io, path, gpa, .unlimited, .of(u8), 0);
    defer gpa.free(data);

    var p = try tide_vcd.Parser.init(gpa, data);
    defer p.deinit(gpa);

    // Signal ids run 1..=count (0 is the .null sentinel). Index a per-id width
    // table by the integer id so the body decoder knows each signal's width.
    const n_sig: usize = p.symbol_table.count;
    const widths = try gpa.alloc(u32, n_sig + 1);
    defer gpa.free(widths);
    @memset(widths, 0);

    // 1. Mirror the hierarchy (and fill `widths`).
    var hb: hier.Builder = .init(gpa);
    errdefer hb.arena.deinit();
    var roots = p.childScopes(.root);
    while (roots.next()) |s| {
        _ = try hb.openScope(s.local_id, mapScopeType(s.type));
        try walkInto(&p, &hb, widths, s.id);
        hb.closeScope();
    }
    var hierarchy = try hb.build();
    errdefer hierarchy.deinit();

    // 2. One tide.Builder per signal, fed from the value-change stream.
    const builders = try gpa.alloc(?tide.Builder, n_sig + 1);
    defer gpa.free(builders);
    @memset(builders, null);
    {
        var id: usize = 1;
        while (id <= n_sig) : (id += 1) {
            if (widths[id] == 0) continue;
            builders[id] = .init(@enumFromInt(id), .{ .kind = .quaternary, .width = widths[id] });
        }
    }
    // Clean up any builders we don't end up consuming (error paths only).
    errdefer for (builders) |*b| if (b.*) |*bb| bb.deinit(gpa);

    var cur_t: u64 = 0;
    var end_t: u64 = 0;
    while (p.next()) |ev| {
        switch (ev) {
            .time => |t| {
                cur_t = t;
                if (t > end_t) end_t = t;
            },
            .scalar => |sc| {
                const sid: u64 = @intFromEnum(sc.code);
                if (sid >= builders.len) continue;
                if (builders[sid]) |*b| try appendScalar(b, gpa, cur_t, sc.value);
            },
            .vector => |vec| {
                const sid: u64 = @intFromEnum(vec.code);
                if (sid >= builders.len) continue;
                if (builders[sid]) |*b| try appendVector(b, gpa, cur_t, vec.value, widths[sid]);
            },
            // tide is quaternary-only: real/string values are skipped (shim).
            // Dump-control events carry no data.
            else => {},
        }
    }

    // 3. Build + insert every signal that received at least one sample.
    var db: tide.Database = .init(gpa);
    errdefer db.deinit();
    for (builders) |*slot| {
        if (slot.*) |*b| {
            if (b.timestamps.items.len == 0) {
                b.deinit(gpa);
            } else {
                const sig = try b.build(gpa);
                try db.insert(sig);
            }
            slot.* = null;
        }
    }

    return .{
        .db = db,
        .hierarchy = hierarchy,
        .end_t = @intCast(if (end_t == 0) 1 else end_t),
    };
}
