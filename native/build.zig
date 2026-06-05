const std = @import("std");

pub fn build(b: *std.Build) void {
    const target = b.standardTargetOptions(.{});
    const optimize = b.standardOptimizeOption(.{});

    const lib_mod = b.createModule(.{
        .root_source_file = b.path("src/main.zig"),
        .target = target,
        .optimize = optimize,
        .link_libc = true,
    });
    lib_mod.addIncludePath(b.path("include"));

    const tide_dep = b.dependency("tide", .{ .target = target, .optimize = optimize });
    lib_mod.addImport("tide", tide_dep.module("tide"));

    const tide_vcd_dep = b.dependency("tide_vcd", .{ .target = target, .optimize = optimize });
    lib_mod.addImport("tide_vcd", tide_vcd_dep.module("tide_vcd"));

    const lib = b.addLibrary(.{
        .linkage = .dynamic,
        .name = "riptide",
        .root_module = lib_mod,
    });

    b.installArtifact(lib);

    // ---- label.zig hand-tuning fixture -------------------------------------
    // Standalone exe (not part of the default build / .node addon): load a VCD,
    // query one signal, run label.formatValue over its transitions. Print mode
    // for correctness, --bench for the perf loop. Reuses the same tide deps.
    //   zig build label-fixture -Doptimize=ReleaseFast -- <vcd> <signalPath> hex --bench
    const fixture_mod = b.createModule(.{
        .root_source_file = b.path("src/label_fixture.zig"),
        .target = target,
        .optimize = optimize,
        .link_libc = true,
    });
    fixture_mod.addImport("tide", tide_dep.module("tide"));
    fixture_mod.addImport("tide_vcd", tide_vcd_dep.module("tide_vcd"));
    const fixture_exe = b.addExecutable(.{
        .name = "label-fixture",
        .root_module = fixture_mod,
    });
    const run_fixture = b.addRunArtifact(fixture_exe);
    if (b.args) |fargs| run_fixture.addArgs(fargs);
    const fixture_step = b.step("label-fixture", "Load a VCD and run/benchmark label.zig on one signal");
    fixture_step.dependOn(&run_fixture.step);

    // ---- seam-B differential fixture ---------------------------------------
    // Standalone exe: the "zig-direct" side of the marshalling differential.
    // Dumps pack.valueAt() over every signal's transition ticks to a file the JS
    // harness replays through the napi addon and diffs byte-for-byte. Installed so
    // build:native can copy it next to the .node addon.
    //   zig build query-fixture -- <vcd> <out.txt> [--max-per-sig=N]
    const query_mod = b.createModule(.{
        .root_source_file = b.path("src/query_fixture.zig"),
        .target = target,
        .optimize = optimize,
        .link_libc = true,
    });
    query_mod.addImport("tide", tide_dep.module("tide"));
    query_mod.addImport("tide_vcd", tide_vcd_dep.module("tide_vcd"));
    const query_exe = b.addExecutable(.{
        .name = "query-fixture",
        .root_module = query_mod,
    });
    b.installArtifact(query_exe);
    const run_query = b.addRunArtifact(query_exe);
    if (b.args) |qargs| run_query.addArgs(qargs);
    const query_step = b.step("query-fixture", "Dump pack.valueAt over a VCD for the seam-B differential");
    query_step.dependOn(&run_query.step);

    // ---- seam-A oracle tests (`zig build test`) ----------------------------
    // In-process tide-core checks against the vcd-tests oracle — no node, no napi.
    // The corpus location comes from $VCD_TESTS_DIR (default ~/Documents/vcd-tests)
    // and is baked into a build-options module the test imports.
    const vcd_tests_dir = b.graph.environ_map.get("VCD_TESTS_DIR") orelse blk: {
        const home = b.graph.environ_map.get("HOME") orelse ".";
        break :blk b.pathJoin(&.{ home, "Documents", "vcd-tests" });
    };
    const test_opts = b.addOptions();
    test_opts.addOption([]const u8, "vcd_tests_dir", vcd_tests_dir);

    const test_mod = b.createModule(.{
        .root_source_file = b.path("src/oracle_test.zig"),
        .target = target,
        .optimize = optimize,
        .link_libc = true,
    });
    test_mod.addIncludePath(b.path("include"));
    test_mod.addImport("tide", tide_dep.module("tide"));
    test_mod.addImport("tide_vcd", tide_vcd_dep.module("tide_vcd"));
    test_mod.addImport("build_options", test_opts.createModule());
    const oracle_tests = b.addTest(.{ .root_module = test_mod });
    const run_oracle_tests = b.addRunArtifact(oracle_tests);
    run_oracle_tests.has_side_effects = true; // re-run on `zig build test` even if cached
    const test_step = b.step("test", "Run seam-A tide-direct oracle tests");
    test_step.dependOn(&run_oracle_tests.step);
}
