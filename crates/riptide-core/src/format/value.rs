//! Value → label formatting. The SINGLE implementation replacing the old
//! dual-impl sync between `native/src/label.zig` and
//! `src/renderer/wave/value.ts`.
//!
//! OWNED BY UNIT U3. Plane convention: tide.rs — a bit is unknown when its p1
//! bit is set; among unknowns, p0=1 → X, p0=0 → Z (NOT the Zig convention; see
//! `trace.rs` module docs). The hex nibble grouping must stay bug-compatible
//! with label.zig (MSB-grouping quirk on non-nibble-aligned widths) so
//! differential label tests stay byte-equal.
//!
//! Two flavors, ported faithfully (they deliberately diverge in places — the
//! per-case comments call those out):
//!
//! - [`format_value`] — the pill-label formatter (`label.zig formatValue`).
//!   Fixed-width hex, no uniform X/Z collapse for hex, enum-miss → hex.
//! - [`format_segment_value`] — the cursor/hover readout formatter
//!   (`value.ts formatSegmentValue`). Leading-zero-trimmed hex, uniform X/Z
//!   collapse for hex/dec/sdec, width-1 short-circuits, enum-miss → binary.

use riptide_contract::spec::{EnumEntry, Radix};

const HEX_UPPER: &[u8; 16] = b"0123456789ABCDEF";

/// Bit `b` (0 = LSB) of a little-endian byte plane. Bits past the plane read
/// as 0 (tide zero-pads above the width).
#[inline]
fn bit_of(plane: &[u8], b: u32) -> u8 {
    let idx = (b >> 3) as usize;
    if idx >= plane.len() {
        return 0;
    }
    (plane[idx] >> (b & 7)) & 1
}

/// Per-bit 4-state classification: `'0' | '1' | 'X' | 'Z'`.
///
/// tide.rs plane convention: p1 set → unknown; among unknowns p0=1 → X,
/// p0=0 → Z. (The Zig `bitChar` used the opposite x/z mapping — this is the
/// plane-swap translation, not a transcription error.)
#[inline]
fn bit_char(x0: &[u8], x1: &[u8], b: u32) -> u8 {
    let p0 = bit_of(x0, b);
    let p1 = bit_of(x1, b);
    if p1 == 0 {
        if p0 == 0 { b'0' } else { b'1' }
    } else if p0 == 0 {
        b'Z'
    } else {
        b'X'
    }
}

/// 4 bits (LSB-first) of a byte plane starting at bit `lo`, read across the
/// byte boundary. Bits past the plane read as 0.
#[inline]
fn nibble(plane: &[u8], lo: u32) -> u8 {
    let idx = (lo >> 3) as usize;
    let sh = lo & 7;
    let mut v: u16 = if idx < plane.len() { plane[idx] as u16 } else { 0 };
    if idx + 1 < plane.len() {
        v |= (plane[idx + 1] as u16) << 8;
    }
    ((v >> sh) & 0xF) as u8
}

/// Low 32 bits of the value (the enum key), little-endian from the x0 plane.
/// Faithful port: BOTH old impls key the enum table on the low word only,
/// even for widths > 32.
#[inline]
fn low_word(x0: &[u8]) -> u32 {
    let mut w: u32 = 0;
    for (b, byte) in x0.iter().take(4).enumerate() {
        w |= (*byte as u32) << (b * 8);
    }
    w
}

/// Whole-value X/Z presence under the tide.rs convention, OR-reduced per byte
/// (each byte holds distinct bits, so `p1 & p0` / `p1 & !p0` never
/// cross-contaminate). X = unknown with p0 set, Z = unknown with p0 clear —
/// the swap of the Zig `(m & ~l)` / `(m & l)` tests.
fn xz_presence(x0: &[u8], x1: &[u8]) -> (bool, bool) {
    let mut has_x = false;
    let mut has_z = false;
    for (i, &p1) in x1.iter().enumerate() {
        let p0 = if i < x0.len() { x0[i] } else { 0 };
        if (p1 & p0) != 0 {
            has_x = true;
        }
        if (p1 & !p0) != 0 {
            has_z = true;
        }
    }
    (has_x, has_z)
}

/// Decimal of an arbitrary-width little-endian value (x0 plane), via repeated
/// divmod-by-10 over a mutable u32-word copy (the `label.zig appendDecimal`
/// approach — hand-rolled, no bignum crate). Only called on the all-defined
/// path. `signed`: two's complement — if the sign bit (MSB) is set, emit '-'
/// and divmod the negated magnitude.
fn append_decimal(out: &mut Vec<u8>, x0: &[u8], width: u32, signed: bool) {
    let words = width.div_ceil(32) as usize;
    let mut buf = vec![0u32; words];
    for (w, word) in buf.iter_mut().enumerate() {
        for b in 0..4 {
            let idx = w * 4 + b;
            if idx < x0.len() {
                *word |= (x0[idx] as u32) << (b * 8);
            }
        }
    }
    // Clear bits above `width` in the top word so masking/negation are exact.
    let top_bits = width & 31;
    if top_bits != 0 {
        buf[words - 1] &= (1u32 << top_bits) - 1;
    }

    // Signed & negative: emit '-' and replace buf with its two's-complement
    // magnitude (~buf + 1, masked back to `width`) before the divmod below.
    if signed && width > 0 && bit_of(x0, width - 1) == 1 {
        out.push(b'-');
        let mut carry: u64 = 1;
        for w in buf.iter_mut() {
            let s = (!*w as u64) + carry;
            *w = s as u32;
            carry = s >> 32;
        }
        if top_bits != 0 {
            buf[words - 1] &= (1u32 << top_bits) - 1;
        }
    }

    // Collect digits least-significant first, then reverse.
    let mut digits: Vec<u8> = Vec::new();
    loop {
        let mut rem: u64 = 0;
        let mut nonzero = false;
        for w in buf.iter_mut().rev() {
            let cur = (rem << 32) | (*w as u64);
            *w = (cur / 10) as u32;
            rem = cur % 10;
            if *w != 0 {
                nonzero = true;
            }
        }
        digits.push(b'0' + rem as u8);
        if !nonzero {
            break;
        }
    }
    out.extend(digits.iter().rev());
}

/// Appends the formatted label of one sample to `out` (ASCII). `x0`/`x1` are
/// the sample's little-endian byte planes ((p0, p1) in tide.rs terms),
/// `bytes_per_sample = ceil(width/8)` bytes each.
///
/// Faithful port of `label.zig formatValue` (the pill-label formatter), with
/// the X/Z plane-classification translated to the tide.rs convention. Output
/// text is byte-identical to the Zig formatter for the same logical 4-state
/// value.
pub fn format_value(
    out: &mut Vec<u8>,
    x0: &[u8],
    x1: &[u8],
    width: u32,
    radix: Radix,
    enums: &[EnumEntry],
) {
    match radix {
        Radix::Bin => {
            // Full width, MSB-first, x/z rendered inline per bit.
            out.reserve(2 + width as usize);
            out.extend_from_slice(b"0b");
            for b in (0..width).rev() {
                out.push(bit_char(x0, x1, b));
            }
            return;
        }
        Radix::Hex => {
            // Nibbles MSB-first, always 0x-prefixed, fixed width (no trim).
            //
            // INTENTIONAL BUG-COMPAT: nibbles are grouped from the MSB side
            // (`hi` starts at width-1 and steps -4), so on non-nibble-aligned
            // widths the LEFTOVER bits land in the BOTTOM nibble instead of
            // the top — e.g. 7-bit 1111011 (0x7B) prints "0xF3". This is the
            // repo's documented "non-nibble-aligned hex bug" (tests/FINDINGS.md
            // B2); kept so differential label text stays byte-equal with the
            // Zig oracle. Fix is a post-migration follow-up.
            let nibbles = width.div_ceil(4) as usize;
            out.reserve(2 + nibbles);
            out.extend_from_slice(b"0x");

            let mut hi = width as i64 - 1;
            while hi >= 0 {
                let lo = (hi - 3).max(0) as u32;
                // Mask off bits above the nibble (the bottom nibble may be
                // < 4 bits wide when the width isn't a multiple of 4).
                let nbits = (hi - lo as i64 + 1) as u32;
                let mask: u8 = ((1u16 << nbits) - 1) as u8;
                let x0n = nibble(x0, lo) & mask;
                let x1n = nibble(x1, lo) & mask;

                // Any unknown bit (p1 set) makes the whole nibble X or Z;
                // among the unknown bits, p0 CLEAR picks Z over X (tide.rs
                // convention — the Zig code tested `x0n & x1n` because its
                // z had lsb set; here Z is p0=0).
                if x1n != 0 {
                    let is_z = (x1n & !x0n) != 0;
                    out.push(if is_z { b'Z' } else { b'X' });
                } else {
                    out.push(HEX_UPPER[x0n as usize]);
                }
                hi -= 4;
            }
            return;
        }
        Radix::Boolean => {
            // Any unknown bit → "x"; else any defined-1 bit → "true"; else
            // "false". Whole-plane OR (padding bits above width are zero —
            // tide zero-pads). The unknown plane (p1) plays the same role as
            // the Zig msb plane, so this branch needs no swap.
            if x1.iter().any(|&b| b != 0) {
                out.extend_from_slice(b"x");
                return;
            }
            let one = x0.iter().any(|&b| b != 0);
            out.extend_from_slice(if one { b"true" as &[u8] } else { b"false" });
            return;
        }
        Radix::Dec | Radix::Sdec | Radix::Enum => {}
    }

    // dec / sdec / enum: whole-value x/z presence.
    let (has_x, has_z) = xz_presence(x0, x1);

    // Enum: match the table on fully-defined values; otherwise format as hex.
    if radix == Radix::Enum {
        if !has_x && !has_z {
            let key = low_word(x0);
            for e in enums {
                if e.value == key {
                    out.extend_from_slice(e.label.as_bytes());
                    return;
                }
            }
        }
        return format_value(out, x0, x1, width, Radix::Hex, &[]);
    }

    // Decimal.
    if has_x || has_z {
        if width == 1 {
            out.push(bit_char(x0, x1, 0));
            return;
        }
        // Classify the whole value (any defined bit / any X / any Z).
        let mut any_x = false;
        let mut any_z = false;
        let mut any_def = false;
        for b in 0..width {
            match bit_char(x0, x1, b) {
                b'X' => any_x = true,
                b'Z' => any_z = true,
                _ => any_def = true,
            }
        }
        // Uniformly-unknown reads better as a bare "X"/"Z" than a digit
        // string.
        if !(any_def || (any_x && any_z)) {
            out.push(if any_z { b'Z' } else { b'X' });
            return;
        }
        // Mixed value: per-bit binary, MSB-first.
        out.extend_from_slice(b"0b");
        for b in (0..width).rev() {
            out.push(bit_char(x0, x1, b));
        }
        return;
    }

    if width == 1 {
        // 1-bit two's complement: bit set is -1 (signed) or 1 (unsigned).
        if radix == Radix::Sdec && bit_of(x0, 0) == 1 {
            out.extend_from_slice(b"-1");
        } else {
            out.push(b'0' + bit_of(x0, 0));
        }
        return;
    }
    append_decimal(out, x0, width, radix == Radix::Sdec);
}

/// The readout-flavored formatter (cursor value column / hover) — faithful
/// port of `value.ts formatSegmentValue`, with the X/Z plane classification
/// translated to the tide.rs convention. Deliberate divergences from
/// [`format_value`] (both ports are faithful to their originals):
///
/// - hex (all-defined): leading zeros trimmed (`0x5`, not `0x05`).
/// - hex with x/z: uniform-unknown collapses to bare "X"/"Z"; a nibble mixing
///   X and Z prints "X" (label.zig prints "Z").
/// - width 1 with x/z: bare bit char for every radix (no `0b`/`0x` prefix).
/// - width 1 defined: bare digit for every radix (even hex).
/// - enum miss / bin: falls back to full-width binary (label.zig: hex).
pub fn format_segment_value(
    x0: &[u8],
    x1: &[u8],
    width: u32,
    radix: Radix,
    enums: &[EnumEntry],
) -> String {
    let mut out: Vec<u8> = Vec::new();

    // Boolean: any defined-1 bit → "true", all-zero → "false", any unknown →
    // "x". Mirrors the single shader's whole-sample non-zeroness decode.
    if radix == Radix::Boolean {
        let p1_any = x1.iter().any(|&b| b != 0);
        let p0_any = x0.iter().any(|&b| b != 0);
        if p1_any {
            return "x".to_string();
        }
        return (if p0_any { "true" } else { "false" }).to_string();
    }

    let (has_x, has_z) = xz_presence(x0, x1);
    if has_x || has_z {
        if width == 1 {
            return (bit_char(x0, x1, 0) as char).to_string();
        }
        let mut any_x = false;
        let mut any_z = false;
        let mut any_def = false;
        for b in 0..width {
            match bit_char(x0, x1, b) {
                b'X' => any_x = true,
                b'Z' => any_z = true,
                _ => any_def = true,
            }
        }
        if matches!(radix, Radix::Hex | Radix::Dec | Radix::Sdec) && !any_def && !(any_x && any_z)
        {
            return (if any_z { "Z" } else { "X" }).to_string();
        }
        if radix == Radix::Hex {
            // Same INTENTIONAL MSB-side nibble grouping bug as format_value
            // (see there) — value.ts had the identical `hi -= 4` loop.
            out.extend_from_slice(b"0x");
            let mut hi = width as i64 - 1;
            while hi >= 0 {
                let mut nib: u8 = 0;
                let mut nib_x = false;
                let mut nib_z = false;
                let mut all_def = true;
                let mut b = hi;
                while b > hi - 4 && b >= 0 {
                    match bit_char(x0, x1, b as u32) {
                        b'1' => nib = (nib << 1) | 1,
                        b'X' => {
                            nib <<= 1;
                            nib_x = true;
                            all_def = false;
                        }
                        b'Z' => {
                            nib <<= 1;
                            nib_z = true;
                            all_def = false;
                        }
                        _ => nib <<= 1,
                    }
                    b -= 1;
                }
                if all_def {
                    out.push(HEX_UPPER[nib as usize]);
                } else if nib_x && nib_z {
                    out.push(b'X');
                } else {
                    out.push(if nib_z { b'Z' } else { b'X' });
                }
                hi -= 4;
            }
            return String::from_utf8(out).expect("ascii");
        }
        // Everything else (bin, dec/sdec mixed, enum): full-width binary.
        out.extend_from_slice(b"0b");
        for b in (0..width).rev() {
            out.push(bit_char(x0, x1, b));
        }
        return String::from_utf8(out).expect("ascii");
    }

    // Enum table match (all-defined only; key is the low 32-bit word).
    if radix == Radix::Enum {
        let key = low_word(x0);
        for e in enums {
            if e.value == key {
                return e.label.clone();
            }
        }
    }

    if width == 1 {
        // 1-bit two's complement: bit set is -1 (signed) or 1 (unsigned).
        if radix == Radix::Sdec {
            return (if bit_of(x0, 0) == 1 { "-1" } else { "0" }).to_string();
        }
        return ((b'0' + bit_of(x0, 0)) as char).to_string();
    }

    if radix == Radix::Hex {
        // Same MSB-side grouping; then trim leading zeros ("0" if all zero).
        let mut digits: Vec<u8> = Vec::new();
        let mut hi = width as i64 - 1;
        while hi >= 0 {
            let mut nib: u8 = 0;
            let mut b = hi;
            while b > hi - 4 && b >= 0 {
                nib = (nib << 1) | bit_of(x0, b as u32);
                b -= 1;
            }
            digits.push(HEX_UPPER[nib as usize]);
            hi -= 4;
        }
        let first = digits.iter().position(|&d| d != b'0');
        out.extend_from_slice(b"0x");
        match first {
            Some(i) => out.extend_from_slice(&digits[i..]),
            None => out.push(b'0'),
        }
        return String::from_utf8(out).expect("ascii");
    }

    if matches!(radix, Radix::Dec | Radix::Sdec) {
        append_decimal(&mut out, x0, width, radix == Radix::Sdec);
        return String::from_utf8(out).expect("ascii");
    }

    // bin / enum miss: full-width binary.
    out.extend_from_slice(b"0b");
    for b in (0..width).rev() {
        out.push(b'0' + bit_of(x0, b));
    }
    String::from_utf8(out).expect("ascii")
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Builds (x0, x1) planes from an MSB-first 4-state bit string under the
    /// tide.rs convention: '0'→(0,0), '1'→(1,0), 'X'→(1,1), 'Z'→(0,1).
    /// Returns (x0, x1, width).
    fn planes(s: &str) -> (Vec<u8>, Vec<u8>, u32) {
        let width = s.len() as u32;
        let bps = width.div_ceil(8) as usize;
        let mut x0 = vec![0u8; bps];
        let mut x1 = vec![0u8; bps];
        for (i, c) in s.chars().rev().enumerate() {
            let (p0, p1) = match c {
                '0' => (0, 0),
                '1' => (1, 0),
                'X' | 'x' => (1, 1),
                'Z' | 'z' => (0, 1),
                _ => panic!("bad bit char {c}"),
            };
            x0[i / 8] |= p0 << (i % 8);
            x1[i / 8] |= p1 << (i % 8);
        }
        (x0, x1, width)
    }

    fn label(s: &str, radix: Radix, enums: &[EnumEntry]) -> String {
        let (x0, x1, width) = planes(s);
        let mut out = Vec::new();
        format_value(&mut out, &x0, &x1, width, radix, enums);
        String::from_utf8(out).unwrap()
    }

    fn readout(s: &str, radix: Radix, enums: &[EnumEntry]) -> String {
        let (x0, x1, width) = planes(s);
        format_segment_value(&x0, &x1, width, radix, enums)
    }

    fn enums_demo() -> Vec<EnumEntry> {
        vec![
            EnumEntry { value: 1, label: "IDLE".into() },
            EnumEntry { value: 2, label: "RUN".into() },
        ]
    }

    // ── bin ──────────────────────────────────────────────────────────────

    #[test]
    fn bin_defined() {
        assert_eq!(label("1010", Radix::Bin, &[]), "0b1010");
        assert_eq!(readout("1010", Radix::Bin, &[]), "0b1010");
        // Full width, no trim.
        assert_eq!(label("00000001", Radix::Bin, &[]), "0b00000001");
        assert_eq!(readout("00000001", Radix::Bin, &[]), "0b00000001");
    }

    #[test]
    fn bin_xz_inline() {
        assert_eq!(label("1X0Z", Radix::Bin, &[]), "0b1X0Z");
        assert_eq!(readout("1X0Z", Radix::Bin, &[]), "0b1X0Z");
    }

    #[test]
    fn bin_width1() {
        assert_eq!(label("1", Radix::Bin, &[]), "0b1");
        // value.ts width-1 short-circuit applies to defined bin too: bare
        // digit, no 0b prefix (the enum-miss/bin "0b" fallback is only ever
        // reached for width > 1).
        assert_eq!(readout("1", Radix::Bin, &[]), "1");
        assert_eq!(readout("0", Radix::Bin, &[]), "0");
        // Divergence (both faithful): label keeps the 0b prefix on a width-1
        // unknown, the readout short-circuits to the bare bit char.
        assert_eq!(label("X", Radix::Bin, &[]), "0bX");
        assert_eq!(readout("X", Radix::Bin, &[]), "X");
        assert_eq!(label("Z", Radix::Bin, &[]), "0bZ");
        assert_eq!(readout("Z", Radix::Bin, &[]), "Z");
    }

    // ── hex ──────────────────────────────────────────────────────────────

    #[test]
    fn hex_defined() {
        assert_eq!(label("10101011", Radix::Hex, &[]), "0xAB");
        assert_eq!(readout("10101011", Radix::Hex, &[]), "0xAB");
    }

    #[test]
    fn hex_leading_zero_trim_divergence() {
        // label.zig: fixed width; value.ts: trimmed.
        assert_eq!(label("0000000010101011", Radix::Hex, &[]), "0x00AB");
        assert_eq!(readout("0000000010101011", Radix::Hex, &[]), "0xAB");
        assert_eq!(label("00000000", Radix::Hex, &[]), "0x00");
        assert_eq!(readout("00000000", Radix::Hex, &[]), "0x0");
    }

    #[test]
    fn hex_non_nibble_aligned_bug_compat() {
        // The documented "non-nibble-aligned hex bug": nibbles group from the
        // MSB side, leftovers land in the bottom nibble. 7-bit 1111011 (true
        // value 0x7B) prints 0xF3 — intentional, byte-equal with the oracle.
        assert_eq!(label("1111011", Radix::Hex, &[]), "0xF3");
        assert_eq!(readout("1111011", Radix::Hex, &[]), "0xF3");
        // 9-bit 111110110 (true 0x1F6): groups 4/4/1 → F, B, 0.
        assert_eq!(label("111110110", Radix::Hex, &[]), "0xFB0");
        assert_eq!(readout("111110110", Radix::Hex, &[]), "0xFB0");
    }

    #[test]
    fn hex_unknown_nibbles() {
        // Whole nibble goes X/Z on any unknown bit.
        assert_eq!(label("1X110000", Radix::Hex, &[]), "0xX0");
        assert_eq!(readout("1X110000", Radix::Hex, &[]), "0xX0");
        assert_eq!(label("ZZZZ0001", Radix::Hex, &[]), "0xZ1");
        assert_eq!(readout("ZZZZ0001", Radix::Hex, &[]), "0xZ1");
    }

    #[test]
    fn hex_uniform_unknown_collapse_divergence() {
        // label.zig hex never collapses; value.ts collapses uniform X / Z.
        assert_eq!(label("XXXXXXXX", Radix::Hex, &[]), "0xXX");
        assert_eq!(readout("XXXXXXXX", Radix::Hex, &[]), "X");
        assert_eq!(label("ZZZZZZZZ", Radix::Hex, &[]), "0xZZ");
        assert_eq!(readout("ZZZZZZZZ", Radix::Hex, &[]), "Z");
        // Mixed X and Z (no defined bits): no collapse in either.
        assert_eq!(label("XXXXZZZZ", Radix::Hex, &[]), "0xXZ");
        assert_eq!(readout("XXXXZZZZ", Radix::Hex, &[]), "0xXZ");
    }

    #[test]
    fn hex_mixed_xz_nibble_divergence() {
        // A nibble containing BOTH X and Z bits: label.zig picks Z (any Z bit
        // wins), value.ts picks X. Both ports are faithful.
        assert_eq!(label("XZ00", Radix::Hex, &[]), "0xZ");
        assert_eq!(readout("XZ00", Radix::Hex, &[]), "0xX");
    }

    #[test]
    fn hex_width1() {
        assert_eq!(label("1", Radix::Hex, &[]), "0x1");
        // value.ts width-1 short-circuit: bare digit, even for hex.
        assert_eq!(readout("1", Radix::Hex, &[]), "1");
        assert_eq!(label("X", Radix::Hex, &[]), "0xX");
        assert_eq!(readout("X", Radix::Hex, &[]), "X");
    }

    #[test]
    fn hex_width_32_33() {
        let w32 = format!("1{}", "0".repeat(31)); // 2^31, width 32 (aligned)
        assert_eq!(label(&w32, Radix::Hex, &[]), "0x80000000");
        assert_eq!(readout(&w32, Radix::Hex, &[]), "0x80000000");
        // Width 33 is non-nibble-aligned → the MSB-grouping bug applies:
        // 2^32 (true 0x100000000) groups as 4/4/.../1 → "0x800000000".
        let w33 = format!("1{}", "0".repeat(32));
        assert_eq!(label(&w33, Radix::Hex, &[]), "0x800000000");
        assert_eq!(readout(&w33, Radix::Hex, &[]), "0x800000000");
    }

    // ── dec / sdec ───────────────────────────────────────────────────────

    #[test]
    fn dec_small_widths() {
        assert_eq!(label("1", Radix::Dec, &[]), "1");
        assert_eq!(label("0", Radix::Dec, &[]), "0");
        assert_eq!(readout("1", Radix::Dec, &[]), "1");
        assert_eq!(label("11001000", Radix::Dec, &[]), "200"); // width 8
        assert_eq!(readout("11001000", Radix::Dec, &[]), "200");
        assert_eq!(label("100000000", Radix::Dec, &[]), "256"); // width 9
        assert_eq!(readout("100000000", Radix::Dec, &[]), "256");
    }

    #[test]
    fn dec_width_32_33() {
        let max32 = "1".repeat(32);
        assert_eq!(label(&max32, Radix::Dec, &[]), "4294967295");
        assert_eq!(readout(&max32, Radix::Dec, &[]), "4294967295");
        let w33 = format!("1{}", "0".repeat(32)); // 2^32
        assert_eq!(label(&w33, Radix::Dec, &[]), "4294967296");
        assert_eq!(readout(&w33, Radix::Dec, &[]), "4294967296");
    }

    #[test]
    fn dec_width_128() {
        let max128 = "1".repeat(128);
        assert_eq!(
            label(&max128, Radix::Dec, &[]),
            "340282366920938463463374607431768211455"
        );
        assert_eq!(
            readout(&max128, Radix::Dec, &[]),
            "340282366920938463463374607431768211455"
        );
    }

    #[test]
    fn sdec_width1() {
        assert_eq!(label("1", Radix::Sdec, &[]), "-1");
        assert_eq!(label("0", Radix::Sdec, &[]), "0");
        assert_eq!(readout("1", Radix::Sdec, &[]), "-1");
        assert_eq!(readout("0", Radix::Sdec, &[]), "0");
    }

    #[test]
    fn sdec_boundaries_width8() {
        assert_eq!(label("10000000", Radix::Sdec, &[]), "-128"); // min
        assert_eq!(label("11111111", Radix::Sdec, &[]), "-1");
        assert_eq!(label("00000000", Radix::Sdec, &[]), "0");
        assert_eq!(label("01111111", Radix::Sdec, &[]), "127"); // max
        assert_eq!(readout("10000000", Radix::Sdec, &[]), "-128");
        assert_eq!(readout("11111111", Radix::Sdec, &[]), "-1");
        assert_eq!(readout("01111111", Radix::Sdec, &[]), "127");
    }

    #[test]
    fn sdec_boundaries_width33() {
        let min = format!("1{}", "0".repeat(32)); // -2^32
        let max = format!("0{}", "1".repeat(32)); // 2^32 - 1
        assert_eq!(label(&min, Radix::Sdec, &[]), "-4294967296");
        assert_eq!(label(&max, Radix::Sdec, &[]), "4294967295");
        assert_eq!(readout(&min, Radix::Sdec, &[]), "-4294967296");
        assert_eq!(readout(&max, Radix::Sdec, &[]), "4294967295");
    }

    #[test]
    fn sdec_boundaries_width128() {
        let min = format!("1{}", "0".repeat(127));
        let max = format!("0{}", "1".repeat(127));
        let all_ones = "1".repeat(128);
        assert_eq!(
            label(&min, Radix::Sdec, &[]),
            "-170141183460469231731687303715884105728"
        );
        assert_eq!(
            label(&max, Radix::Sdec, &[]),
            "170141183460469231731687303715884105727"
        );
        assert_eq!(label(&all_ones, Radix::Sdec, &[]), "-1");
        assert_eq!(
            readout(&min, Radix::Sdec, &[]),
            "-170141183460469231731687303715884105728"
        );
    }

    #[test]
    fn dec_unknown_collapse_and_mixed() {
        // Uniformly unknown → bare X / Z.
        assert_eq!(label("XXXXXXXX", Radix::Dec, &[]), "X");
        assert_eq!(label("ZZZZZZZZ", Radix::Dec, &[]), "Z");
        assert_eq!(readout("XXXXXXXX", Radix::Dec, &[]), "X");
        assert_eq!(readout("ZZZZZZZZ", Radix::Dec, &[]), "Z");
        // X and Z mixed, or any defined bit → binary fallback.
        assert_eq!(label("XZ", Radix::Dec, &[]), "0bXZ");
        assert_eq!(readout("XZ", Radix::Dec, &[]), "0bXZ");
        assert_eq!(label("1X00", Radix::Dec, &[]), "0b1X00");
        assert_eq!(readout("1X00", Radix::Dec, &[]), "0b1X00");
        // Width-1 unknown: bare bit char in both.
        assert_eq!(label("X", Radix::Dec, &[]), "X");
        assert_eq!(readout("Z", Radix::Dec, &[]), "Z");
        // sdec takes the same x/z path.
        assert_eq!(label("XXXXXXXX", Radix::Sdec, &[]), "X");
        assert_eq!(readout("ZZZZZZZZ", Radix::Sdec, &[]), "Z");
    }

    // ── enum ─────────────────────────────────────────────────────────────

    #[test]
    fn enum_hit() {
        let e = enums_demo();
        assert_eq!(label("00000010", Radix::Enum, &e), "RUN");
        assert_eq!(readout("00000010", Radix::Enum, &e), "RUN");
        assert_eq!(label("00000001", Radix::Enum, &e), "IDLE");
    }

    #[test]
    fn enum_miss_fallback_divergence() {
        // label.zig: miss → hex; value.ts: miss → full-width binary.
        let e = enums_demo();
        assert_eq!(label("00000011", Radix::Enum, &e), "0x03");
        assert_eq!(readout("00000011", Radix::Enum, &e), "0b00000011");
    }

    #[test]
    fn enum_unknown_fallback() {
        // Unknown bits never match the table.
        let e = enums_demo();
        assert_eq!(label("XXXXXXXX", Radix::Enum, &e), "0xXX");
        assert_eq!(readout("XXXXXXXX", Radix::Enum, &e), "0bXXXXXXXX");
        assert_eq!(label("000000Z0", Radix::Enum, &e), "0x0Z");
        assert_eq!(readout("000000Z0", Radix::Enum, &e), "0b000000Z0");
    }

    #[test]
    fn enum_key_is_low_word_only() {
        // Faithful port: the enum key is the LOW 32-bit word, even when
        // higher bits are set (width 40, value 0x01_00000002 matches "RUN").
        let s = format!("00000001{}10", "0".repeat(30));
        let e = enums_demo();
        assert_eq!(label(&s, Radix::Enum, &e), "RUN");
        assert_eq!(readout(&s, Radix::Enum, &e), "RUN");
    }

    // ── boolean ──────────────────────────────────────────────────────────

    #[test]
    fn boolean_values() {
        assert_eq!(label("00000000", Radix::Boolean, &[]), "false");
        assert_eq!(label("00010000", Radix::Boolean, &[]), "true");
        assert_eq!(label("0000000Z", Radix::Boolean, &[]), "x");
        assert_eq!(label("X0000000", Radix::Boolean, &[]), "x");
        assert_eq!(readout("00000000", Radix::Boolean, &[]), "false");
        assert_eq!(readout("00010000", Radix::Boolean, &[]), "true");
        assert_eq!(readout("0000000X", Radix::Boolean, &[]), "x");
        assert_eq!(readout("1", Radix::Boolean, &[]), "true");
        assert_eq!(readout("Z", Radix::Boolean, &[]), "x");
    }

    // ── plane-convention regression ──────────────────────────────────────

    #[test]
    fn xz_plane_swap_pairs() {
        // Raw-plane check of the tide.rs convention: p1 set = unknown;
        // p0=1 → X, p0=0 → Z. (Under the old Zig convention these two would
        // print swapped.)
        let mut out = Vec::new();
        format_value(&mut out, &[0xFF], &[0xFF], 8, Radix::Dec, &[]); // p0=1,p1=1
        assert_eq!(out, b"X");
        out.clear();
        format_value(&mut out, &[0x00], &[0xFF], 8, Radix::Dec, &[]); // p0=0,p1=1
        assert_eq!(out, b"Z");
        out.clear();
        // Per-bit: 0b01 planes p0=0b01 p1=0b10 → bit1 unknown p0=0 → Z, bit0=1.
        format_value(&mut out, &[0b01], &[0b10], 2, Radix::Bin, &[]);
        assert_eq!(out, b"0bZ1");
        out.clear();
        format_value(&mut out, &[0b11], &[0b10], 2, Radix::Bin, &[]);
        assert_eq!(out, b"0bX1");
        // Hex nibble Z-pick under tide.rs: unknown bits with p0 clear → Z.
        out.clear();
        format_value(&mut out, &[0x00], &[0x0F], 8, Radix::Hex, &[]);
        assert_eq!(out, b"0x0Z");
        out.clear();
        format_value(&mut out, &[0x0F], &[0x0F], 8, Radix::Hex, &[]);
        assert_eq!(out, b"0x0X");
    }

    // ── oracle vectors (ported from the Zig fixture / vcd-tests seam C) ──

    #[test]
    fn oracle_style_vectors() {
        // VCD `bxxxx` on a 4-bit reg: uniform X. (Plane bits rewritten to the
        // tide.rs convention by `planes`; expected text unchanged — a VCD `x`
        // prints X under both conventions.)
        assert_eq!(label("XXXX", Radix::Hex, &[]), "0xX");
        assert_eq!(label("XXXX", Radix::Dec, &[]), "X");
        assert_eq!(label("XXXX", Radix::Bin, &[]), "0bXXXX");
        // VCD `bz` partial assign zero-extends... per tide semantics the
        // remaining bits stay as parsed; pure-Z nibble:
        assert_eq!(label("ZZZZ", Radix::Hex, &[]), "0xZ");
        // 16-bit counter values as the fixture prints them (fixed width).
        assert_eq!(label("0000000000000000", Radix::Hex, &[]), "0x0000");
        assert_eq!(label("0000000100000000", Radix::Hex, &[]), "0x0100");
        assert_eq!(label("0000000100000000", Radix::Dec, &[]), "256");
    }
}
