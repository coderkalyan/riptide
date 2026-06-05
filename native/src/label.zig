const std = @import("std");
const Allocator = std.mem.Allocator;

// Radix and enum metadata needed to format a multi-bit value into its pill
// label. Mirrors the renderer's Radix type + per-row enum maps.
// `@"enum"` formats via the per-row enum table (value→label), falling back to
// hex for unmatched values and X/Z bits. `dec` is unsigned, `sdec` two's-complement
// signed (both share the divmod path; sdec negates the magnitude first).
pub const Radix = enum { bin, hex, dec, sdec, @"enum" };
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

// 4 bits (LSB-first) of a tide byte plane starting at bit `lo`, read across the
// byte boundary. Bits past the plane read as 0 (zero-padded above the width).
inline fn nibble(plane: []const u8, lo: usize) u8 {
    const idx = lo >> 3;
    const sh: u4 = @intCast(lo & 7);
    var v: u16 = if (idx < plane.len) plane[idx] else 0;
    if (idx + 1 < plane.len) v |= @as(u16, plane[idx + 1]) << 8;
    return @intCast((v >> sh) & 0xF);
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
// `signed`: treat the value as two's complement — if the sign bit (MSB) is set,
// emit '-' and divmod the negated magnitude.
fn appendDecimal(out: *std.ArrayList(u8), gpa: Allocator, x0: []const u8, width: u32, signed: bool) !void {
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
    // Clear bits above `width` in the top word so masking/negation are exact.
    const top_bits: u5 = @intCast(width & 31);
    if (top_bits != 0) buf[words - 1] &= (@as(u32, 1) << top_bits) - 1;

    // Signed & negative: emit '-' and replace buf with its two's-complement
    // magnitude (~buf + 1, masked back to `width`) before the divmod below.
    if (signed and bitOf(x0, width - 1) == 1) {
        try out.append(gpa, '-');
        var carry: u64 = 1;
        var i: u32 = 0;
        while (i < words) : (i += 1) {
            const s = @as(u64, ~buf[i]) + carry;
            buf[i] = @truncate(s);
            carry = s >> 32;
        }
        if (top_bits != 0) buf[words - 1] &= (@as(u32, 1) << top_bits) - 1;
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

inline fn bitmask(in: u8) u8 {
    const signed: i8 = @bitCast(in);
    return @bitCast(-signed);
}

// Format a multi-bit value into `out`. x0/x1 are tide's per-sample
// little-endian byte planes (value bits / unknown bits).
pub fn formatValue(
    out: *std.ArrayList(u8),
    gpa: Allocator,
    x0s: []const u8,
    x1s: []const u8,
    width: u32,
    radix: Radix,
    enums: []const EnumEntry,
) !void {
    switch (radix) {
        .bin => {
            try out.ensureUnusedCapacity(gpa, 2 + width);
            out.appendSliceAssumeCapacity("0b");

            var i: i64 = width - 1;
            while (i >= 0) : (i -= 1) {
                const byte = @as(usize, @intCast(i)) >> 3;
                const bit = @as(usize, @intCast(i)) & 0x7;
                const x0 = (x0s[byte] >> @intCast(bit)) & 0x1;
                const x1 = (x1s[byte] >> @intCast(bit)) & 0x1;

                // Start by choosing either '0' or 'X' depending on x1.
                var char: u8 = '0';
                char += ('X' - '0') & bitmask(x1);

                // Use x0 to shift char to '0' -> '1', or 'X' -> 'Y'.
                char += @as(u8, 1) & bitmask(x0);

                // If x0 & x1, shift 'Y' -> 'Z'.
                char += @as(u8, 1) & bitmask(x0 & x1);

                out.appendAssumeCapacity(char);
            }

            return;
        },
        .hex => {
            // Nibbles MSB-first, always 0x-prefixed, fixed width (no trim).
            const nibbles = (width + 3) / 4;
            try out.ensureUnusedCapacity(gpa, 2 + nibbles);
            out.appendSliceAssumeCapacity("0x");

            var hi: i64 = @as(i64, @intCast(width)) - 1;
            while (hi >= 0) : (hi -= 4) {
                const lo: usize = @intCast(@max(hi - 3, 0));
                // Mask off bits above the nibble (the bottom nibble may be < 4
                // bits wide when the width isn't a multiple of 4).
                const nbits: u3 = @intCast(hi - @as(i64, @intCast(lo)) + 1);
                const mask: u8 = (@as(u8, 1) << nbits) - 1;
                const x0n = nibble(x0s, lo) & mask;
                const x1n = nibble(x1s, lo) & mask;

                // Any unknown bit (x1 set) makes the whole nibble X or Z; x0 of
                // the unknown bits picks Z (set) over X. Otherwise x0 is the hex
                // digit. Branchless: build both, select with an all-ones mask.
                const unknown = bitmask(@intFromBool(x1n != 0));
                const isz = bitmask(@intFromBool((x0n & x1n) != 0));
                const hex_char = HEX_UPPER[x0n];
                const unk_char = @as(u8, 'X') + (@as(u8, 'Z' - 'X') & isz);
                out.appendAssumeCapacity((hex_char & ~unknown) | (unk_char & unknown));
            }
            return;
        },
        else => {}, // dec, enum
    }

    // dec / enum: whole-value x/z presence, OR-reduced per byte (each byte holds
    // distinct bits, so (m & ~l)/(m & l) never cross-contaminate).
    var has_x = false;
    var has_z = false;
    {
        var i: usize = 0;
        while (i < x1s.len) : (i += 1) {
            const m = x1s[i];
            const l: u8 = if (i < x0s.len) x0s[i] else 0;
            if ((m & ~l) != 0) has_x = true;
            if ((m & l) != 0) has_z = true;
        }
    }

    // Enum: match the table on fully-defined values; otherwise format as hex.
    if (radix == .@"enum") {
        if (!has_x and !has_z) {
            const key = lowWord(x0s);
            for (enums) |e| {
                if (e.value == key) {
                    try out.appendSlice(gpa, e.label);
                    return;
                }
            }
        }
        return formatValue(out, gpa, x0s, x1s, width, .hex, &.{});
    }

    // Decimal.
    if (has_x or has_z) {
        if (width == 1) {
            try out.append(gpa, bitChar(x0s, x1s, 0));
            return;
        }
        // Classify the whole value (any defined bit / any X / any Z).
        var any_x = false;
        var any_z = false;
        var any_def = false;
        {
            var b: u32 = 0;
            while (b < width) : (b += 1) {
                switch (bitChar(x0s, x1s, b)) {
                    'X' => any_x = true,
                    'Z' => any_z = true,
                    else => any_def = true,
                }
            }
        }
        // Uniformly-unknown reads better as a bare "X"/"Z" than a digit string.
        if (!any_def and !(any_x and any_z)) {
            try out.append(gpa, if (any_z) 'Z' else 'X');
            return;
        }
        // Mixed value: per-bit binary, MSB-first.
        try out.appendSlice(gpa, "0b");
        var b: i64 = @as(i64, width) - 1;
        while (b >= 0) : (b -= 1) {
            try out.append(gpa, bitChar(x0s, x1s, @intCast(b)));
        }
        return;
    }

    if (width == 1) {
        // 1-bit two's complement: bit set is -1 (signed) or 1 (unsigned).
        if (radix == .sdec and bitOf(x0s, 0) == 1) {
            try out.appendSlice(gpa, "-1");
        } else {
            try out.append(gpa, '0' + @as(u8, bitOf(x0s, 0)));
        }
        return;
    }
    try appendDecimal(out, gpa, x0s, width, radix == .sdec);
}
