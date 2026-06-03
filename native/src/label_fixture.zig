const std = @import("std");
const tide = @import("tide");
const mock_db = @import("mock_db.zig");
const label = @import("label.zig");
const hier = @import("hier.zig");

// Standalone harness for hand-tuning label.zig (native value-label formatting).
// Loads a VCD, resolves one signal by its hierarchical path, then either prints
// the formatted label at each transition (correctness check while you tune) or
// benchmarks the format loop in isolation (--bench). All output is on stderr via
// std.debug.print, so piping stdout stays clean.
//
//   zig build label-fixture -- <vcd>                           # list signal paths
//   zig build label-fixture -- <vcd> <path> [bin|hex|dec]      # print first N labels
//   zig build label-fixture -Doptimize=ReleaseFast -- <vcd> <path> hex --bench
//
// Flags: --list  --bench  --limit=N (print mode, default 32)  --repeat=R (bench, default 50)
//
// NOTE: enums are passed empty (&.{}) — the enum-match path isn't exercised here.
// Hardcode an EnumEntry slice below if you need to tune that branch.

fn parseRadix(s: []const u8) ?label.Radix {
    if (std.mem.eql(u8, s, "bin")) return .bin;
    if (std.mem.eql(u8, s, "hex")) return .hex;
    if (std.mem.eql(u8, s, "dec")) return .dec;
    if (std.mem.eql(u8, s, "enum")) return .@"enum";
    return null;
}

// Build a node's dotted path by walking root → node (parent first).
fn writePath(h: *const hier.Hierarchy, gpa: std.mem.Allocator, id: hier.NodeId, out: *std.ArrayList(u8)) !void {
    const node = h.nodes.items[id];
    if (node.parent) |p| {
        try writePath(h, gpa, p, out);
        try out.append(gpa, '.');
    }
    try out.appendSlice(gpa, node.name);
}

pub fn main(init: std.process.Init) !void {
    const gpa = init.gpa;
    const io = init.io;

    var vcd_path: ?[]const u8 = null;
    var sig_path: ?[]const u8 = null;
    var radix: label.Radix = .hex;
    var list_mode = false;
    var bench = false;
    var limit: usize = 32;
    var repeat: usize = 50;

    var positional: usize = 0;
    var it = init.minimal.args.iterate();
    _ = it.next(); // skip argv[0] (program name)
    while (it.next()) |a| {
        if (std.mem.startsWith(u8, a, "--limit=")) {
            limit = std.fmt.parseInt(usize, a["--limit=".len..], 10) catch limit;
        } else if (std.mem.startsWith(u8, a, "--repeat=")) {
            repeat = std.fmt.parseInt(usize, a["--repeat=".len..], 10) catch repeat;
        } else if (std.mem.eql(u8, a, "--list")) {
            list_mode = true;
        } else if (std.mem.eql(u8, a, "--bench")) {
            bench = true;
        } else if (std.mem.startsWith(u8, a, "--")) {
            std.debug.print("unknown flag: {s}\n", .{a});
            return error.BadArg;
        } else switch (positional) {
            0 => {
                vcd_path = a;
                positional += 1;
            },
            1 => {
                sig_path = a;
                positional += 1;
            },
            2 => {
                radix = parseRadix(a) orelse {
                    std.debug.print("bad radix '{s}' (want bin|hex|dec|enum)\n", .{a});
                    return error.BadArg;
                };
                positional += 1;
            },
            else => {},
        }
    }

    const vcd = vcd_path orelse {
        std.debug.print("usage: label-fixture <vcd> [signalPath] [bin|hex|dec] [--list] [--bench] [--limit=N] [--repeat=R]\n", .{});
        return error.BadArg;
    };

    std.debug.print("loading {s} ...\n", .{vcd});
    const t_load = std.Io.Clock.now(.awake, io);
    var loaded = try mock_db.load(gpa, vcd);
    defer loaded.deinit();
    const load_ms: i64 = @intCast(@divTrunc(t_load.durationTo(std.Io.Clock.now(.awake, io)).nanoseconds, std.time.ns_per_ms));
    std.debug.print("loaded in {d} ms (end_t={d})\n", .{ load_ms, loaded.end_t });

    const h = &loaded.hierarchy;

    // No signal path (or --list) → dump every signal's resolvable path + width + id.
    if (sig_path == null or list_mode) {
        var path: std.ArrayList(u8) = .empty;
        defer path.deinit(gpa);
        var n: usize = 0;
        for (h.nodes.items) |node| {
            if (node.payload != .signal) continue;
            path.clearRetainingCapacity();
            try writePath(h, gpa, node.id, &path);
            std.debug.print("{s}\twidth={d}\tid={d}\n", .{ path.items, node.payload.signal.bit_width, @intFromEnum(node.payload.signal.handle) });
            n += 1;
        }
        std.debug.print("({d} signals)\n", .{n});
        return;
    }

    const want = sig_path.?;

    // Resolve path → tide handle by walking the hierarchy (no built-in lookup).
    var handle: ?tide.Signal.Id = null;
    {
        var path: std.ArrayList(u8) = .empty;
        defer path.deinit(gpa);
        for (h.nodes.items) |node| {
            if (node.payload != .signal) continue;
            path.clearRetainingCapacity();
            try writePath(h, gpa, node.id, &path);
            if (std.mem.eql(u8, path.items, want)) {
                handle = node.payload.signal.handle;
                break;
            }
        }
    }
    const id = handle orelse {
        std.debug.print("signal not found: '{s}' (run with no path, or --list, to see options)\n", .{want});
        return error.NotFound;
    };

    // One query over the whole trace → all transitions of this signal. Slices
    // borrow into db storage and stay valid until the next query, so we reuse
    // them across the whole bench loop below.
    const q = loaded.db.query(id, 0, loaded.end_t) orelse {
        std.debug.print("no samples for '{s}'\n", .{want});
        return error.NoData;
    };
    const bps = q.type.bytes();
    const width = q.type.width;
    const len: usize = @intCast(q.len);
    std.debug.print("signal '{s}' width={d} transitions={d} radix={s}\n", .{ want, width, len, @tagName(radix) });

    var out: std.ArrayList(u8) = .empty;
    defer out.deinit(gpa);

    if (bench) {
        // Time ONLY the format loop (query already done). checksum keeps the
        // optimizer from eliding the work.
        var checksum: u64 = 0;
        const t0 = std.Io.Clock.now(.awake, io);
        var r: usize = 0;
        while (r < repeat) : (r += 1) {
            var k: usize = 0;
            while (k < len) : (k += 1) {
                out.clearRetainingCapacity();
                const x0 = q.x0s[k * bps .. (k + 1) * bps];
                const x1 = q.x1s[k * bps .. (k + 1) * bps];
                try label.formatValue(&out, gpa, x0, x1, width, radix, &.{});
                checksum +%= out.items.len;
                if (out.items.len > 0) checksum +%= out.items[0];
            }
        }
        const ns: i96 = t0.durationTo(std.Io.Clock.now(.awake, io)).nanoseconds;
        const total: u64 = @as(u64, len) * @as(u64, repeat);
        const ns_f: f64 = @floatFromInt(ns);
        const total_f: f64 = @floatFromInt(total);
        std.debug.print(
            "bench: {d} labels ({d} transitions x {d} repeats) in {d:.2} ms => {d:.1} ns/label, {d:.2} M/s [checksum={d}]\n",
            .{ total, len, repeat, ns_f / 1e6, ns_f / total_f, total_f / (ns_f / 1e9) / 1e6, checksum },
        );
        return;
    }

    // Print mode: first `limit` labels with their tick, for eyeballing output.
    var k: usize = 0;
    while (k < len and k < limit) : (k += 1) {
        out.clearRetainingCapacity();
        const x0 = q.x0s[k * bps .. (k + 1) * bps];
        const x1 = q.x1s[k * bps .. (k + 1) * bps];
        try label.formatValue(&out, gpa, x0, x1, width, radix, &.{});
        std.debug.print("[{d}] t={d} = {s}\n", .{ k, q.timestamps[k], out.items });
    }
    if (len > limit) std.debug.print("... ({d} more — raise --limit=N or use --bench)\n", .{len - limit});
}
