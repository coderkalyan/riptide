const std = @import("std");
const Allocator = std.mem.Allocator;
const tide = @import("tide");
const tide_vcd = @import("tide_vcd");
const seg = @import("segments.zig");
const hier = @import("hier.zig");

const Bits = seg.Bits;

// The mock scene now lives entirely in a bundled VCD fixture rather than in
// hand-built tide.Builder calls. We parse it with tide-vcd, mirror its hierarchy
// into hier.Hierarchy, and stream its value-change events into a tide.Database.
// Regenerate the fixture with native/scripts/gen_mock_vcd.py.
const VCD = @embedFile("mock.vcd");

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

fn charBits(c: u8) Bits {
    return switch (c) {
        '0' => .{ .lsb = 0, .msb = 0 },
        '1' => .{ .lsb = 1, .msb = 0 },
        'z', 'Z' => .{ .lsb = 1, .msb = 1 },
        else => .{ .lsb = 0, .msb = 1 }, // x/X and extended values
    };
}

// MSB-first VCD vector string → (lsb,msb) for a width-bit signal, left-extended
// per the VCD rule: pad with '0' for 0/1-leading values, else with the leading
// x/z character. width ≤ 32.
fn decodeVector(value: []const u8, width: u32) Bits {
    std.debug.assert(value.len >= 1);
    const lead = value[0];
    const pad: u8 = if (lead == '0' or lead == '1') '0' else lead;
    var lsb: u32 = 0;
    var msb: u32 = 0;
    var i: u32 = 0;
    while (i < width) : (i += 1) {
        // Bit i (LSB = 0) is the i-th char from the right of the MSB-first
        // string, or the pad char once we run past its length.
        const c: u8 = if (i < value.len) value[value.len - 1 - i] else pad;
        const b = charBits(c);
        const shift: u5 = @intCast(i);
        lsb |= b.lsb << shift;
        msb |= b.msb << shift;
    }
    return .{ .lsb = lsb, .msb = msb };
}

fn writeBits(dst_x0: []u8, dst_x1: []u8, lsb: u32, msb: u32) void {
    for (dst_x0, 0..) |*b, i| b.* = @truncate(lsb >> @intCast(i * 8));
    for (dst_x1, 0..) |*b, i| b.* = @truncate(msb >> @intCast(i * 8));
}

fn appendBits(b: *tide.Builder, gpa: Allocator, ts: u64, bits: Bits) !void {
    var x0 = [_]u8{0} ** 4;
    var x1 = [_]u8{0} ** 4;
    const bps = b.type.bytes();
    writeBits(x0[0..bps], x1[0..bps], bits.lsb, bits.msb);
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

pub fn load(gpa: Allocator) !Loaded {
    var p = try tide_vcd.Parser.init(gpa, VCD);
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
                if (builders[sid]) |*b| try appendBits(b, gpa, cur_t, charBits(sc.value));
            },
            .vector => |vec| {
                const sid: u64 = @intFromEnum(vec.code);
                if (sid >= builders.len) continue;
                if (builders[sid]) |*b| {
                    const bits = decodeVector(vec.value, widths[sid]);
                    try appendBits(b, gpa, cur_t, bits);
                }
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
