//! Value labels for waveform rows.
//!
//! Formats one sample of tide's byte planes into the ASCII a pill or a boolean
//! line shows. A sample is bounds plus a high impedance mask, little-endian:
//! `0` is `(min 0, max 0)`, `1` is `(1, 1)`, `x` is `(0, 1)` and `z` is `(0, 1)`
//! with its `z` bit set. A bit is unknown exactly where the bounds disagree, so
//! `min ^ max` is the unknown mask and `min` is the value with every unknown bit
//! read as zero.
//!
//! Output is appended to a caller-owned buffer and must stay byte-for-byte
//! identical to the renderer's `wave/value.ts` `formatSegmentValue`, which
//! formats the same values CPU-side for the active-signal value column.
use tide_core::metadata::Width;

/// How to render a value. `Enum` looks the value up in the row's table and falls
/// back to hex for an unmatched value or any unknown bit. `Dec` is unsigned,
/// `Sdec` two's complement. `Boolean` renders on the single (line) pipeline but
/// still carries a `true`/`false`/`x` label.
#[derive(Clone, Copy, PartialEq, Eq, Debug, Default)]
pub enum Radix {
    #[default]
    Bin,
    Hex,
    Dec,
    Sdec,
    Enum,
    Boolean,
}

impl Radix {
    /// Parses the renderer's spelling. Anything unrecognized is binary, matching
    /// the scalar default in `scene.ts`'s pack specs.
    pub fn parse(name: &str) -> Radix {
        match name {
            "hex" => Radix::Hex,
            "dec" => Radix::Dec,
            "sdec" => Radix::Sdec,
            "enum" => Radix::Enum,
            "boolean" => Radix::Boolean,
            _ => Radix::Bin,
        }
    }

    /// Whether this radix renders as a pill (multi pipeline) rather than a
    /// high/low line. Routing is format-driven, not width-driven.
    pub fn is_multi(self) -> bool {
        !matches!(self, Radix::Bin | Radix::Boolean)
    }

    /// Whether a segment of this radix carries a value label at all. Binary
    /// (plain, clock and reset rows) is the only unlabeled format.
    pub fn is_labeled(self) -> bool {
        self != Radix::Bin
    }
}

/// One row's integer to name mapping, as the sidecar records it.
pub struct EnumEntry {
    pub value: u32,
    pub label: String,
}

const HEX_UPPER: &[u8; 16] = b"0123456789ABCDEF";

/// Bit `b` (0 = LSB) of a little-endian byte plane. Bits past the plane read as
/// zero, which is what the planes are padded with above the declared width.
fn bit_of(bytes: &[u8], b: u32) -> u8 {
    let index = (b >> 3) as usize;
    if index >= bytes.len() {
        return 0;
    }
    (bytes[index] >> (b & 7)) & 1
}

/// Per-bit four-state classification. The bounds disagree exactly on an unknown
/// bit, and the `z` plane then says which unknown it is.
fn bit_char(min: &[u8], max: &[u8], z: &[u8], b: u32) -> u8 {
    let (low, high) = (bit_of(min, b), bit_of(max, b));
    let unknown = low ^ high;
    let pick = if unknown == 1 { bit_of(z, b) } else { low };
    STATE_CHARS[(unknown << 1 | pick) as usize]
}

/// The four states, indexed by `unknown << 1` plus the value bit when known and
/// the high impedance bit when not.
const STATE_CHARS: [u8; 4] = [b'0', b'1', b'X', b'Z'];

/// Four bits of a plane starting at bit `lo`, read across the byte boundary.
fn nibble(plane: &[u8], lo: usize) -> u8 {
    let index = lo >> 3;
    let shift = lo & 7;
    let mut value = u16::from(plane.get(index).copied().unwrap_or(0));
    value |= u16::from(plane.get(index + 1).copied().unwrap_or(0)) << 8;
    ((value >> shift) & 0xf) as u8
}

/// Low 32 bits of the value, which is the enum table's key.
fn low_word(min: &[u8]) -> u32 {
    let mut word = 0;
    for (index, &byte) in min.iter().take(4).enumerate() {
        word |= u32::from(byte) << (index * 8);
    }
    word
}

/// `1 -> 0xff`, `0 -> 0x00`, for branchless selection.
fn bitmask(input: u8) -> u8 {
    (input as i8).wrapping_neg() as u8
}

/// Decimal of an arbitrary width little-endian value, by repeated divmod by ten
/// over a mutable word copy. Matches the renderer's `BigInt` path, so widths past
/// 32 bits print exactly. Only reached when every bit is known.
///
/// `signed` reads the value as two's complement: a set sign bit emits `-` and the
/// magnitude is negated before the divmod.
fn append_decimal(out: &mut Vec<u8>, min: &[u8], width: Width, signed: bool) {
    let words = width.div_ceil(32) as usize;
    let mut buf = vec![0u32; words];
    for (index, word) in buf.iter_mut().enumerate() {
        for byte in 0..4 {
            if let Some(&value) = min.get(index * 4 + byte) {
                *word |= u32::from(value) << (byte * 8);
            }
        }
    }

    // Clear bits above `width` in the top word so masking and negation are exact.
    let top_bits = width & 31;
    let mask_top = |buf: &mut [u32]| {
        if top_bits != 0 {
            buf[words - 1] &= (1u32 << top_bits) - 1;
        }
    };
    mask_top(&mut buf);

    if signed && bit_of(min, width - 1) == 1 {
        out.push(b'-');
        let mut carry = 1u64;
        for word in &mut buf {
            let sum = u64::from(!*word) + carry;
            *word = sum as u32;
            carry = sum >> 32;
        }
        mask_top(&mut buf);
    }

    // Least significant digit first, then reversed in place.
    let start = out.len();
    loop {
        let mut remainder = 0u64;
        let mut nonzero = false;
        for word in buf.iter_mut().rev() {
            let current = (remainder << 32) | u64::from(*word);
            *word = (current / 10) as u32;
            remainder = current % 10;
            nonzero |= *word != 0;
        }
        out.push(b'0' + remainder as u8);
        if !nonzero {
            break;
        }
    }
    out[start..].reverse();
}

/// Appends the label for one sample. `min`, `max` and `z` are that sample's
/// per-plane byte runs, exactly `ceil(width / 8)` bytes each.
pub fn format_value(
    out: &mut Vec<u8>,
    min: &[u8],
    max: &[u8],
    z: &[u8],
    width: Width,
    radix: Radix,
    enums: &[EnumEntry],
) {
    match radix {
        Radix::Bin => {
            out.reserve(2 + width as usize);
            out.extend_from_slice(b"0b");
            for bit in (0..width).rev() {
                out.push(bit_char(min, max, z, bit));
            }
            return;
        }
        Radix::Hex => {
            // Nibbles are aligned to the LSB, so the *top* nibble carries the
            // leftover `width % 4` bits: a 7-bit 0x7b prints "7B", not "F3".
            // Always prefixed, never trimmed. Keep in lockstep with value.ts.
            let nibbles = width.div_ceil(4) as usize;
            out.reserve(2 + nibbles);
            out.extend_from_slice(b"0x");

            let mut lo = ((width - 1) / 4 * 4) as usize;
            loop {
                let hi_bit = (lo + 3).min(width as usize - 1);
                let bits = hi_bit - lo + 1;
                let mask = ((1u16 << bits) - 1) as u8;
                let low = nibble(min, lo) & mask;
                let unknown_bits = (low ^ nibble(max, lo)) & mask;

                // Any unknown bit poisons the whole nibble, and one of those bits
                // being high impedance makes it Z rather than X.
                let unknown = bitmask(u8::from(unknown_bits != 0));
                let is_z = bitmask(u8::from((unknown_bits & nibble(z, lo)) != 0));
                let hex = HEX_UPPER[low as usize];
                let unknown_char = b'X' + ((b'Z' - b'X') & is_z);
                out.push((hex & !unknown) | (unknown_char & unknown));

                if lo < 4 {
                    break;
                }
                lo -= 4;
            }
            return;
        }
        Radix::Boolean => {
            // Whole-plane reduction: the planes are zero above the declared width.
            if min.iter().zip(max).any(|(&low, &high)| low != high) {
                out.extend_from_slice(b"x");
            } else if min.iter().any(|&byte| byte != 0) {
                out.extend_from_slice(b"true");
            } else {
                out.extend_from_slice(b"false");
            }
            return;
        }
        Radix::Dec | Radix::Sdec | Radix::Enum => {}
    }

    // Whole-value x/z presence, reduced per byte. Each byte holds distinct bits,
    // so the two tests never cross-contaminate.
    let mut has_x = false;
    let mut has_z = false;
    for (index, (&low, &high)) in min.iter().zip(max).enumerate() {
        let unknown = low ^ high;
        let high_impedance = z.get(index).copied().unwrap_or(0);
        has_x |= (unknown & !high_impedance) != 0;
        has_z |= (unknown & high_impedance) != 0;
    }

    if radix == Radix::Enum {
        if !has_x && !has_z {
            let key = low_word(min);
            if let Some(entry) = enums.iter().find(|entry| entry.value == key) {
                out.extend_from_slice(entry.label.as_bytes());
                return;
            }
        }
        return format_value(out, min, max, z, width, Radix::Hex, &[]);
    }

    if has_x || has_z {
        if width == 1 {
            out.push(bit_char(min, max, z, 0));
            return;
        }

        let (mut any_x, mut any_z, mut any_defined) = (false, false, false);
        for bit in 0..width {
            match bit_char(min, max, z, bit) {
                b'X' => any_x = true,
                b'Z' => any_z = true,
                _ => any_defined = true,
            }
        }

        // A uniformly unknown value reads better as a bare X or Z than as a
        // digit string.
        if !(any_defined || any_x && any_z) {
            out.push(if any_z { b'Z' } else { b'X' });
            return;
        }

        // Mixed: per-bit binary, most significant first.
        out.extend_from_slice(b"0b");
        for bit in (0..width).rev() {
            out.push(bit_char(min, max, z, bit));
        }
        return;
    }

    if width == 1 {
        // One-bit two's complement: a set bit is -1 signed, 1 unsigned.
        if radix == Radix::Sdec && bit_of(min, 0) == 1 {
            out.extend_from_slice(b"-1");
        } else {
            out.push(b'0' + bit_of(min, 0));
        }
        return;
    }

    append_decimal(out, min, width, radix == Radix::Sdec);
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Planes for a value written most significant bit first, in the four-state
    /// spelling the oracle uses. Building tests from text rather than hand-packed
    /// planes keeps them readable and survives a change of encoding.
    fn planes(bits: &str) -> (Vec<u8>, Vec<u8>, Vec<u8>) {
        let bytes = bits.len().div_ceil(8);
        let (mut min, mut max, mut z) = (vec![0u8; bytes], vec![0u8; bytes], vec![0u8; bytes]);
        for (index, digit) in bits.chars().rev().enumerate() {
            let (byte, shift) = (index / 8, index % 8);
            let (low, high, impedance) = match digit {
                '0' => (0, 0, 0),
                '1' => (1, 1, 0),
                'x' => (0, 1, 0),
                'z' => (0, 1, 1),
                other => panic!("not a four-state digit: {other}"),
            };
            min[byte] |= low << shift;
            max[byte] |= high << shift;
            z[byte] |= impedance << shift;
        }
        (min, max, z)
    }

    /// Formats a value written as four-state text; the width is its length.
    fn format(bits: &str, radix: Radix) -> String {
        let (min, max, z) = planes(bits);
        let mut out = Vec::new();
        format_value(&mut out, &min, &max, &z, bits.len() as Width, radix, &[]);
        String::from_utf8(out).unwrap()
    }

    #[test]
    fn binary_prints_every_declared_bit() {
        assert_eq!("0b0000", format("0000", Radix::Bin));
        assert_eq!("0b1010", format("1010", Radix::Bin));
        assert_eq!("0bXZXZ", format("xzxz", Radix::Bin));
        // Wider than one byte, most significant bit first.
        assert_eq!("0b0000000100000000", format("0000000100000000", Radix::Bin));
    }

    #[test]
    fn hex_nibbles_align_to_the_lsb() {
        // A 7-bit 0x7b keeps its low nibble whole: the leftover 3 bits are the
        // top nibble, so this is "7B" and never "F3".
        assert_eq!("0x7B", format("1111011", Radix::Hex));
        assert_eq!("0x0A", format("00001010", Radix::Hex));
        assert_eq!("0x1AB", format("110101011", Radix::Hex));
    }

    #[test]
    fn one_unknown_bit_poisons_its_whole_nibble() {
        // The high nibble is untouched either way.
        assert_eq!("0x1X", format("0001001x", Radix::Hex));
        assert_eq!("0x1Z", format("0001001z", Radix::Hex));
        // A nibble holding both reads as Z: high impedance is the louder fault.
        assert_eq!("0x1Z", format("000100xz", Radix::Hex));
    }

    #[test]
    fn decimal_spans_widths_past_a_word() {
        assert_eq!("0", format("00000000", Radix::Dec));
        assert_eq!("255", format("11111111", Radix::Dec));
        // 2^64, which no u64 path could print.
        let wide = format!("1{}", "0".repeat(64));
        assert_eq!("18446744073709551616", format(&wide, Radix::Dec));
    }

    #[test]
    fn signed_decimal_negates_the_magnitude() {
        assert_eq!("255", format("11111111", Radix::Dec));
        assert_eq!("-1", format("11111111", Radix::Sdec));
        assert_eq!("-128", format("10000000", Radix::Sdec));
        assert_eq!("127", format("01111111", Radix::Sdec));
        // One bit wide is its own case: the sign bit is the only bit.
        assert_eq!("-1", format("1", Radix::Sdec));
        assert_eq!("1", format("1", Radix::Dec));
    }

    #[test]
    fn decimal_falls_back_to_bits_only_when_the_value_is_mixed() {
        // Uniformly unknown reads as a bare letter.
        assert_eq!("X", format("xxxxxxxx", Radix::Dec));
        assert_eq!("Z", format("zzzzzzzz", Radix::Dec));
        // One unknown bit among known ones falls back to per-bit binary.
        assert_eq!("0b0000000Z", format("0000000z", Radix::Dec));
        // Both an X and a Z present is mixed even with no defined bit.
        assert_eq!("0bZX", format("zx", Radix::Dec));
    }

    #[test]
    fn booleans_reduce_the_whole_value() {
        assert_eq!("false", format(&"0".repeat(16), Radix::Boolean));
        assert_eq!("true", format("1000000000000000", Radix::Boolean));
        assert_eq!("x", format("000000z000000000", Radix::Boolean));
    }

    #[test]
    fn enums_match_on_the_low_word_and_fall_back_to_hex() {
        let table = [
            EnumEntry {
                value: 0,
                label: "IDLE".into(),
            },
            EnumEntry {
                value: 2,
                label: "RUN".into(),
            },
        ];
        let format = |bits: &str| {
            let (min, max, z) = planes(bits);
            let mut out = Vec::new();
            format_value(&mut out, &min, &max, &z, 4, Radix::Enum, &table);
            String::from_utf8(out).unwrap()
        };

        assert_eq!("IDLE", format("0000"));
        assert_eq!("RUN", format("0010"));
        // No table entry, and any unknown bit, both fall through to hex.
        assert_eq!("0x3", format("0011"));
        assert_eq!("0xZ", format("zzzz"));
    }
}
