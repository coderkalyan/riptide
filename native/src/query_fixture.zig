const std = @import("std");
const tide = @import("tide");
const mock_db = @import("mock_db.zig");
const pack = @import("pack.zig");
const hier = @import("hier.zig");

// Seam-B differential — the "zig-direct" side. Loads a VCD and, for every signal,
// samples pack.valueAt(db, id, tick) at (a stride of) its transition ticks — the
// SAME function the napi addon's getValueAt calls. Each result is dumped as a line
//
//     <id> <tick> <width> <x0hex> <x1hex>
//
// to the output file (arg 2). The JS harness (tests/differential.test.cjs) replays
// every (id, tick) through the production addon and asserts byte-equality. Any
// mutation introduced by the napi boundary (word packing, truncation, byte order,
// x/z loss) shows up as a diff — no oracle needed (METHODOLOGY §5).
//
//   zig build query-fixture -- <vcd> <out.txt> [--max-per-sig=N]
//
// x0/x1 are tide's storage bytes (LSB-first), hex lowercase. A trace whose ticks
// exceed 2^32 panics in mock_db.load (same as the addon) — the parent records the
// crash, exactly as the other suites do.

const MAX_PER_SIG_DEFAULT: usize = 400;

fn writePath(h: *const hier.Hierarchy, gpa: std.mem.Allocator, id: hier.NodeId, out: *std.ArrayList(u8)) !void {
    const node = h.nodes.items[id];
    if (node.parent) |p| {
        try writePath(h, gpa, p, out);
        try out.append(gpa, '.');
    }
    try out.appendSlice(gpa, node.name);
}

fn appendHex(out: *std.ArrayList(u8), gpa: std.mem.Allocator, bytes: []const u8) !void {
    const hexd = "0123456789abcdef";
    if (bytes.len == 0) {
        try out.append(gpa, '-'); // empty value plane
        return;
    }
    for (bytes) |b| {
        try out.append(gpa, hexd[b >> 4]);
        try out.append(gpa, hexd[b & 0xf]);
    }
}

pub fn main(init: std.process.Init) !void {
    const gpa = init.gpa;
    const io = init.io;

    var vcd_path: ?[]const u8 = null;
    var out_path: ?[]const u8 = null;
    var max_per_sig: usize = MAX_PER_SIG_DEFAULT;

    var positional: usize = 0;
    var it = init.minimal.args.iterate();
    _ = it.next(); // argv[0]
    while (it.next()) |a| {
        if (std.mem.startsWith(u8, a, "--max-per-sig=")) {
            max_per_sig = std.fmt.parseInt(usize, a["--max-per-sig=".len..], 10) catch max_per_sig;
        } else if (std.mem.startsWith(u8, a, "--")) {
            std.debug.print("unknown flag: {s}\n", .{a});
            return error.BadArg;
        } else switch (positional) {
            0 => {
                vcd_path = a;
                positional += 1;
            },
            1 => {
                out_path = a;
                positional += 1;
            },
            else => {},
        }
    }

    const vcd = vcd_path orelse {
        std.debug.print("usage: query-fixture <vcd> <out.txt> [--max-per-sig=N]\n", .{});
        return error.BadArg;
    };
    const out_file = out_path orelse {
        std.debug.print("usage: query-fixture <vcd> <out.txt> [--max-per-sig=N]\n", .{});
        return error.BadArg;
    };

    var loaded = try mock_db.load(gpa, vcd); // may panic on >u32 ticks (== addon)
    defer loaded.deinit();
    const h = &loaded.hierarchy;
    const end_t = loaded.end_t;

    var out: std.ArrayList(u8) = .empty;
    defer out.deinit(gpa);
    var buf: [64]u8 = undefined;

    for (h.nodes.items) |node| {
        if (node.payload != .signal) continue;
        const id = node.payload.signal.handle;
        const q = loaded.db.query(id, 0, end_t) orelse continue;
        const len: usize = @intCast(q.len);
        if (len == 0) continue;

        // Stride so dense signals emit at most max_per_sig samples (always incl.
        // first + last). Deterministic — no RNG, no wall clock.
        const stride: usize = if (len <= max_per_sig) 1 else (len + max_per_sig - 1) / max_per_sig;
        var k: usize = 0;
        while (k < len) : (k += stride) {
            const tick = q.timestamps[k];
            const v = pack.valueAt(&loaded.db, id, tick) orelse continue;
            try out.appendSlice(gpa, std.fmt.bufPrint(&buf, "{d} {d} {d} ", .{ @intFromEnum(id), tick, v.width }) catch unreachable);
            try appendHex(&out, gpa, v.x0);
            try out.append(gpa, ' ');
            try appendHex(&out, gpa, v.x1);
            try out.append(gpa, '\n');
        }
        // Ensure the final transition is always covered.
        if (len > 1 and (len - 1) % stride != 0) {
            const tick = q.timestamps[len - 1];
            if (pack.valueAt(&loaded.db, id, tick)) |v| {
                try out.appendSlice(gpa, std.fmt.bufPrint(&buf, "{d} {d} {d} ", .{ @intFromEnum(id), tick, v.width }) catch unreachable);
                try appendHex(&out, gpa, v.x0);
                try out.append(gpa, ' ');
                try appendHex(&out, gpa, v.x1);
                try out.append(gpa, '\n');
            }
        }
    }

    try std.Io.Dir.cwd().writeFile(io, .{ .sub_path = out_file, .data = out.items });
    std.debug.print("query-fixture: wrote {d} bytes for {s}\n", .{ out.items.len, vcd });
}
