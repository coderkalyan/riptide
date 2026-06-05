const std = @import("std");
const tide = @import("tide");
const mock_db = @import("mock_db.zig");
const pack = @import("pack.zig");
const hier = @import("hier.zig");
const cfg = @import("build_options");

// Seam A — tide core correctness, in-process, NO node / NO napi. For each oracle
// fixture this loads the VCD straight through mock_db (tide-vcd + tide.Database),
// resolves each oracle signal path to a tide handle, and asserts that
// pack.valueAt(db, id, tick) — the same core query the addon wraps — decodes to
// the oracle's `raw` bits at every spread sample (METHODOLOGY §4, seam A).
//
// Because there is no boundary here, a divergence is a *core* bug; a clean pass
// plus a clean differential (seam B) localizes any value bug to the boundary.
//
//   zig build test                      # uses $VCD_TESTS_DIR or ~/Documents/vcd-tests
//   VCD_TESTS_DIR=/path zig build test
//
// Skips (with reasons, by design — these are reported bugs/gaps, see FINDINGS.md):
//   - time_long_sparse / time_u64_extreme : ticks > 2^32 panic in mock_db.load.
//   - real signals                        : pack.valueAt returns bits, not the f64.
//   - event signals                       : pack.valueAt aborts (bug B3).

// Fixed corpus (deterministic). Add a name here when a new oracle lands. The two
// u32-overflow fixtures are intentionally absent — they crash at parse (bug B1).
const FIXTURES = [_][]const u8{
    "act_burst_idle",   "bit_order",          "feat_aliases",   "feat_dumpoff_on",
    "feat_id_charset",  "feat_var_types",     "hier_balanced_soc", "hier_deep_narrow",
    "hier_flat_wide",   "hier_many_scopes",   "scale_medium",   "scale_small",
    "sig_constants",    "sig_enum_radix",     "sig_real",       "sig_widths",
    "sig_xz",           "smoke_basic",        "stress_many_active", "stress_wide_fast",
    "time_fs_timescale", "time_glitches",     "time_long_dense_clk", "time_multiclock",
};

const Resolved = struct { handle: tide.Signal.Id, width: u32 };

fn buildPath(h: *const hier.Hierarchy, gpa: std.mem.Allocator, id: hier.NodeId, out: *std.ArrayList(u8)) !void {
    const node = h.nodes.items[id];
    if (node.parent) |p| {
        try buildPath(h, gpa, p, out);
        try out.append(gpa, '.');
    }
    try out.appendSlice(gpa, node.name);
}

// Map oracle path -> tide handle + width, by walking the loaded hierarchy.
fn resolve(h: *const hier.Hierarchy, gpa: std.mem.Allocator, want: []const u8) !?Resolved {
    var path: std.ArrayList(u8) = .empty;
    defer path.deinit(gpa);
    for (h.nodes.items) |node| {
        if (node.payload != .signal) continue;
        path.clearRetainingCapacity();
        try buildPath(h, gpa, node.id, &path);
        if (std.mem.eql(u8, path.items, want)) {
            return .{ .handle = node.payload.signal.handle, .width = node.payload.signal.bit_width };
        }
    }
    return null;
}

fn isBitString(s: []const u8) bool {
    if (s.len == 0) return false;
    for (s) |ch| switch (ch) {
        '0', '1', 'x', 'z', 'X', 'Z' => {},
        else => return false,
    };
    return true;
}

// MSB-first 4-state decode of a (x0,x1) byte pair, matching the renderer/shader
// LSB/MSB convention: (m,l) = (0,0)=0 (0,1)=1 (1,0)=x (1,1)=z.
fn decodeBits(out: *std.ArrayList(u8), gpa: std.mem.Allocator, x0: []const u8, x1: []const u8, width: u32) !void {
    out.clearRetainingCapacity();
    var i: i64 = @as(i64, width) - 1;
    while (i >= 0) : (i -= 1) {
        const bit: usize = @intCast(i);
        const byte = bit / 8;
        const shift: u3 = @intCast(bit % 8);
        const l: u1 = if (byte < x0.len) @intCast((x0[byte] >> shift) & 1) else 0;
        const m: u1 = if (byte < x1.len) @intCast((x1[byte] >> shift) & 1) else 0;
        const ch: u8 = if (m == 1) (if (l == 1) 'z' else 'x') else (if (l == 1) '1' else '0');
        try out.append(gpa, ch);
    }
}

var total_checked: usize = 0;
var total_skipped: usize = 0;

test "seam A: tide-direct value_at vs oracle" {
    // page_allocator (not testing.allocator) on purpose: mock_db/tide arena-own a
    // lot of trace state that's released at process exit in production (the addon
    // loads via page_allocator too). Leak-checking it here would flag those
    // intentional process-lifetime allocations, not real bugs. This is an
    // integration test of values, not a leak test.
    const gpa = std.heap.page_allocator;
    const io = std.Io.Threaded.global_single_threaded.io();

    var failures: usize = 0;

    for (FIXTURES) |name| {
        var arena = std.heap.ArenaAllocator.init(gpa);
        defer arena.deinit();
        const a = arena.allocator();

        const oracle_path = try std.fmt.allocPrint(a, "{s}/oracle/{s}.json", .{ cfg.vcd_tests_dir, name });
        const vcd_path = try std.fmt.allocPrint(a, "{s}/fixtures/{s}.vcd", .{ cfg.vcd_tests_dir, name });

        const json_bytes = std.Io.Dir.cwd().readFileAllocOptions(io, oracle_path, a, .unlimited, .of(u8), 0) catch |e| {
            std.debug.print("seam-A: cannot read {s}: {s}\n", .{ oracle_path, @errorName(e) });
            failures += 1;
            continue;
        };
        const parsed = try std.json.parseFromSliceLeaky(std.json.Value, a, json_bytes, .{});

        var loaded = try mock_db.load(gpa, vcd_path);
        defer loaded.deinit();
        const h = &loaded.hierarchy;

        // Hierarchy widths.
        for (parsed.object.get("hierarchy").?.array.items) |hn| {
            const hp = hn.object.get("path").?.string;
            const hw: u32 = @intCast(hn.object.get("width").?.integer);
            const r = (try resolve(h, a, hp)) orelse {
                std.debug.print("seam-A {s}: hierarchy missing path {s}\n", .{ name, hp });
                failures += 1;
                continue;
            };
            if (r.width != hw) {
                std.debug.print("seam-A {s}: {s} width {d} != oracle {d}\n", .{ name, hp, r.width, hw });
                failures += 1;
            }
        }

        var bits: std.ArrayList(u8) = .empty;
        defer bits.deinit(a);

        for (parsed.object.get("cases").?.array.items) |case| {
            const cname = case.object.get("name").?.string;
            var sit = case.object.get("signals").?.object.iterator();
            while (sit.next()) |entry| {
                const sigpath = entry.key_ptr.*;
                const sig = entry.value_ptr.*.object;
                const stype = if (sig.get("type")) |t| t.string else "";
                // Skip whole signals we can't (yet) value-check via the bit path.
                if (std.mem.eql(u8, stype, "event")) {
                    total_skipped += 1;
                    continue; // pack.valueAt(event) aborts — bug B3
                }
                if (std.mem.eql(u8, stype, "real")) {
                    total_skipped += 1;
                    continue;
                }
                const r = (try resolve(h, a, sigpath)) orelse {
                    std.debug.print("seam-A {s}/{s}: unresolved {s}\n", .{ name, cname, sigpath });
                    failures += 1;
                    continue;
                };

                for (sig.get("samples").?.array.items) |samp| {
                    const raw_v = samp.object.get("raw").?;
                    if (raw_v != .string) {
                        total_skipped += 1;
                        continue;
                    }
                    const raw = raw_v.string;
                    if (!isBitString(raw)) {
                        total_skipped += 1;
                        continue;
                    }
                    const tick = std.fmt.parseInt(u64, samp.object.get("t").?.string, 10) catch {
                        total_skipped += 1;
                        continue;
                    };
                    const v = pack.valueAt(&loaded.db, r.handle, tick) orelse {
                        std.debug.print("seam-A {s}/{s}: {s}@{d} valueAt null\n", .{ name, cname, sigpath, tick });
                        failures += 1;
                        continue;
                    };
                    try decodeBits(&bits, a, v.x0, v.x1, r.width);
                    if (!std.mem.eql(u8, bits.items, raw)) {
                        std.debug.print("seam-A {s}/{s}: {s}@{d} = {s} != oracle {s}\n", .{ name, cname, sigpath, tick, bits.items, raw });
                        failures += 1;
                    } else {
                        total_checked += 1;
                    }
                }
            }
        }
    }

    std.debug.print(
        "\n── seam-A (tide-direct) ──\n  samples checked: {d}\n  samples skipped (real/event/non-bit): {d}\n  failures: {d}\n\n",
        .{ total_checked, total_skipped, failures },
    );
    try std.testing.expect(failures == 0);
}
