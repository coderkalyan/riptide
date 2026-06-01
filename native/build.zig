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
}
