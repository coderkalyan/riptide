const std = @import("std");
const Allocator = std.mem.Allocator;

// Radix and enum metadata needed to format a multi-bit value into its pill
// label. Mirrors the renderer's Radix type + per-row enum maps.
pub const Radix = enum { bin, hex, dec };
pub const EnumEntry = struct { value: u32, label: []const u8 };

const HEX_UPPER = "0123456789ABCDEF";

// Bit `b` (0 = LSB) of a tide little-endian byte plane.
inline fn bitOf(bytes: []const u8, b: u32) u1 {
    const idx = b >> 3;
    if (idx >= bytes.len) return 0;
    return @intCast((bytes[idx] >> @intCast(b & 7)) & 1);
}

// Per-bit 2-state classification: '0' | '1' | 'X' | 'Z'. (m,l) = (x1,x0) bit.
inline fn bitChar(x0: []const u8, x1: []const u8, b: u32) u8 {
    const l = bitOf(x0, b);
    const m = bitOf(x1, b);
    if (m == 0) return if (l == 0) '0' else '1';
    return if (l == 0) 'X' else 'Z';
}

// Low 32 bits of the value (enum key), little-endian from the x0 byte plane.
fn lowWord(x0: []const u8) u32 {
    var w: u32 = 0;
    var b: u32 = 0;
    while (b < 4) : (b += 1) {
        if (b < x0.len) w |= @as(u32, x0[b]) << @intCast(b * 8);
    }
    return w;
}

// Decimal of an arbitrary-width little-endian value (x0 byte plane), via
// repeated divmod-by-10 over a mutable u32-word copy. Matches the JS BigInt
// path so widths > 32 print exactly. Only called on the all-defined dec path.
fn appendDecimal(out: *std.ArrayList(u8), gpa: Allocator, x0: []const u8, width: u32) !void {
    const words: u32 = (width + 31) / 32;
    var buf = try gpa.alloc(u32, words);
    defer gpa.free(buf);
    var w: u32 = 0;
    while (w < words) : (w += 1) {
        var word: u32 = 0;
        var b: u32 = 0;
        while (b < 4) : (b += 1) {
            const idx = w * 4 + b;
            if (idx < x0.len) word |= @as(u32, x0[idx]) << @intCast(b * 8);
        }
        buf[w] = word;
    }

    // Collect digits least-significant first, then reverse.
    var digits: std.ArrayList(u8) = .empty;
    defer digits.deinit(gpa);
    while (true) {
        var rem: u64 = 0;
        var nonzero = false;
        var i: usize = words;
        while (i > 0) {
            i -= 1;
            const cur = (rem << 32) | buf[i];
            buf[i] = @intCast(cur / 10);
            rem = cur % 10;
            if (buf[i] != 0) nonzero = true;
        }
        try digits.append(gpa, @as(u8, '0') + @as(u8, @intCast(rem)));
        if (!nonzero) break;
    }
    var k: usize = digits.items.len;
    while (k > 0) {
        k -= 1;
        try out.append(gpa, digits.items[k]);
    }
}

// Format a multi-bit value into `out`. x0/x1 are tide's per-sample little-endian
// byte planes (value bits / unknown bits). Faithful port of the renderer's
// formatSegmentValue (src/renderer/App.tsx) so labels match byte-for-byte — the
// renderer still uses formatSegmentValue for the single cursor/hover value column,
// so the two MUST stay in sync. Wired into the pill-label path via Scene.pushMultiLabel
// (segments.zig) / packQuery (pack.zig) → getMockSegments' labelBytes/labelOffsets.
pub fn formatValue(
    out: *std.ArrayList(u8),
    gpa: Allocator,
    x0: []const u8,
    x1: []const u8,
    width: u32,
    radix: Radix,
    enums: []const EnumEntry,
) !void {
    // Whole-value x/z presence, OR-reduced per byte (each byte holds distinct
    // bits, so (m & ~l)/(m & l) never cross-contaminate).
    var has_x = false;
    var has_z = false;
    {
        var i: usize = 0;
        while (i < x1.len) : (i += 1) {
            const m = x1[i];
            const l: u8 = if (i < x0.len) x0[i] else 0;
            if ((m & ~l) != 0) has_x = true;
            if ((m & l) != 0) has_z = true;
        }
    }

    if (has_x or has_z) {
        if (width == 1) {
            try out.append(gpa, bitChar(x0, x1, 0));
            return;
        }
        // Classify the whole value (any defined bit / any X / any Z).
        var any_x = false;
        var any_z = false;
        var any_def = false;
        {
            var b: u32 = 0;
            while (b < width) : (b += 1) {
                switch (bitChar(x0, x1, b)) {
                    'X' => any_x = true,
                    'Z' => any_z = true,
                    else => any_def = true,
                }
            }
        }
        // Uniformly-unknown hex/dec reads better as a bare "X"/"Z" than "0xXX".
        if ((radix == .hex or radix == .dec) and !any_def and !(any_x and any_z)) {
            try out.append(gpa, if (any_z) 'Z' else 'X');
            return;
        }
        if (radix == .hex) {
            try out.appendSlice(gpa, "0x");
            // Nibbles MSB-first. Pure-X/Z nibble prints "X"/"Z"; mixed prints "X".
            var hi: i64 = @as(i64, width) - 1;
            while (hi >= 0) : (hi -= 4) {
                var nib: u4 = 0;
                var nib_x = false;
                var nib_z = false;
                var all_def = true;
                var b: i64 = hi;
                while (b > hi - 4 and b >= 0) : (b -= 1) {
                    const c = bitChar(x0, x1, @intCast(b));
                    nib = (nib << 1) | @as(u4, @intCast(@intFromBool(c == '1')));
                    if (c == 'X') {
                        nib_x = true;
                        all_def = false;
                    } else if (c == 'Z') {
                        nib_z = true;
                        all_def = false;
                    }
                }
                if (all_def) {
                    try out.append(gpa, HEX_UPPER[nib]);
                } else if (nib_x and nib_z) {
                    try out.append(gpa, 'X');
                } else {
                    try out.append(gpa, if (nib_z) 'Z' else 'X');
                }
            }
            return;
        }
        // Binary (and the decimal mixed-value fallback): per-bit, MSB-first.
        try out.appendSlice(gpa, "0b");
        var b: i64 = @as(i64, width) - 1;
        while (b >= 0) : (b -= 1) {
            try out.append(gpa, bitChar(x0, x1, @intCast(b)));
        }
        return;
    }

    // All bits defined (2-state). Enum keys are <=32-bit, so the low word suffices.
    if (enums.len > 0) {
        const key = lowWord(x0);
        for (enums) |e| {
            if (e.value == key) {
                try out.appendSlice(gpa, e.label);
                return;
            }
        }
    }
    if (width == 1) {
        try out.append(gpa, '0' + @as(u8, bitOf(x0, 0)));
        return;
    }
    if (radix == .hex) {
        // Nibbles MSB-first, trim leading zeros (one digit min).
        var nibs: std.ArrayList(u8) = .empty;
        defer nibs.deinit(gpa);
        var hi: i64 = @as(i64, width) - 1;
        while (hi >= 0) : (hi -= 4) {
            var nib: u4 = 0;
            var b: i64 = hi;
            while (b > hi - 4 and b >= 0) : (b -= 1) {
                nib = (nib << 1) | @as(u4, bitOf(x0, @intCast(b)));
            }
            try nibs.append(gpa, HEX_UPPER[nib]);
        }
        try out.appendSlice(gpa, "0x");
        var start: usize = 0;
        while (start + 1 < nibs.items.len and nibs.items[start] == '0') start += 1;
        try out.appendSlice(gpa, nibs.items[start..]);
        return;
    }
    if (radix == .dec) {
        try appendDecimal(out, gpa, x0, width);
        return;
    }
    // Binary: per-bit MSB-first.
    try out.appendSlice(gpa, "0b");
    var b: i64 = @as(i64, width) - 1;
    while (b >= 0) : (b -= 1) {
        try out.append(gpa, '0' + @as(u8, bitOf(x0, @intCast(b))));
    }
}
