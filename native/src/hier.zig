const std = @import("std");
const Allocator = std.mem.Allocator;
const tide = @import("tide");

pub const NodeId = u32;

pub const ScopeType = enum {
    module,
    task,
    function,
    begin,
    fork,
    generate,
    struct_,
    union_,
    class_,
    interface_,
    package,
    program,
};

pub const VarType = enum {
    vcd_wire,
    vcd_reg,
};

pub const Direction = enum {
    implicit,
    input,
    output,
    inout,
    buffer,
    linkage,
};

pub const ScopePayload = struct {
    scope_type: ScopeType,
    children: std.ArrayListUnmanaged(NodeId),
};

pub const SignalPayload = struct {
    var_type: VarType,
    direction: Direction,
    bit_width: u32,
    handle: tide.Signal.Id,
};

pub const Node = struct {
    id: NodeId,
    parent: ?NodeId,
    name: []const u8,
    payload: union(enum) {
        scope: ScopePayload,
        signal: SignalPayload,
    },
};

pub const Hierarchy = struct {
    arena: std.heap.ArenaAllocator,
    nodes: std.ArrayListUnmanaged(Node),
    root_ids: std.ArrayListUnmanaged(NodeId),

    pub fn deinit(h: *Hierarchy) void {
        h.arena.deinit();
    }
};

pub const AddSignalOpts = struct {
    name: []const u8,
    var_type: VarType,
    direction: Direction = .implicit,
    bit_width: u32,
    handle: tide.Signal.Id,
};

pub const Builder = struct {
    arena: std.heap.ArenaAllocator,
    nodes: std.ArrayListUnmanaged(Node),
    root_ids: std.ArrayListUnmanaged(NodeId),
    stack: std.ArrayListUnmanaged(NodeId),

    pub fn init(gpa: Allocator) Builder {
        return .{
            .arena = std.heap.ArenaAllocator.init(gpa),
            .nodes = .empty,
            .root_ids = .empty,
            .stack = .empty,
        };
    }

    fn alloc(b: *Builder) Allocator {
        return b.arena.allocator();
    }

    pub fn openScope(b: *Builder, name: []const u8, t: ScopeType) !NodeId {
        const a = b.alloc();
        const id: NodeId = @intCast(b.nodes.items.len);
        const parent: ?NodeId = if (b.stack.items.len == 0) null else b.stack.items[b.stack.items.len - 1];

        try b.nodes.append(a, .{
            .id = id,
            .parent = parent,
            .name = try a.dupe(u8, name),
            .payload = .{ .scope = .{ .scope_type = t, .children = .empty } },
        });

        if (parent) |p| {
            try b.nodes.items[p].payload.scope.children.append(a, id);
        } else {
            try b.root_ids.append(a, id);
        }

        try b.stack.append(a, id);
        return id;
    }

    pub fn closeScope(b: *Builder) void {
        std.debug.assert(b.stack.items.len > 0);
        _ = b.stack.pop();
    }

    pub fn addSignal(b: *Builder, opts: AddSignalOpts) !NodeId {
        std.debug.assert(b.stack.items.len > 0);
        const a = b.alloc();
        const parent = b.stack.items[b.stack.items.len - 1];
        const id: NodeId = @intCast(b.nodes.items.len);

        try b.nodes.append(a, .{
            .id = id,
            .parent = parent,
            .name = try a.dupe(u8, opts.name),
            .payload = .{ .signal = .{
                .var_type = opts.var_type,
                .direction = opts.direction,
                .bit_width = opts.bit_width,
                .handle = opts.handle,
            } },
        });

        try b.nodes.items[parent].payload.scope.children.append(a, id);
        return id;
    }

    pub fn build(b: *Builder) !Hierarchy {
        if (b.stack.items.len != 0) return error.UnclosedScope;
        return .{
            .arena = b.arena,
            .nodes = b.nodes,
            .root_ids = b.root_ids,
        };
    }
};
