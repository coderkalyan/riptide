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
}
