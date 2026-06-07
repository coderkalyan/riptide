// Per-signal value formatting — the CPU-side value column + hover readout. Ports
// App.tsx's valueAtTick / formatSegmentValue / buildEnumLabels verbatim. (This is
// a byte-for-byte sibling of the native label.zig formatter — keep in sync.)
import { getValueAt } from "../native";
import { enumTableForRef, type ActiveSignalRef, type Radix } from "../hier/scene";

// Decoded (lsb, msb) value of a signal at a tick via the native tide query.
// lsb/msb are little-endian u32 word arrays (one word per 32 bits of width).
export type SegValueLM = { lsb: number[]; msb: number[] };
export function valueAtTick(handle: string, tick: number): SegValueLM | undefined {
  return getValueAt(handle, Math.floor(tick)) ?? undefined;
}

// Bit `bit` of a word-array value (0 or 1).
function bitOfWords(words: number[], bit: number): number {
  return (words[bit >>> 5] >>> (bit & 31)) & 1;
}

export function formatSegmentValue(
  value: SegValueLM | undefined,
  bitWidth: number,
  radix: Radix,
  enumLabels?: Map<number, string>,
): string {
  if (!value) return "-";
  // Boolean: any defined-1 bit → "true", all-zero → "false", any unknown → "x".
  // Mirrors the single shader's whole-sample non-zeroness decode (high = value ≠ 0).
  if (radix === "boolean") {
    let lsbAny = false, msbAny = false;
    for (let w = 0; w < value.lsb.length; w++) {
      if (value.lsb[w] >>> 0) lsbAny = true;
      if ((value.msb[w] ?? 0) >>> 0) msbAny = true;
    }
    if (msbAny) return "x";
    return lsbAny ? "true" : "false";
  }
  let hasX = false, hasZ = false;
  for (let w = 0; w < value.msb.length; w++) {
    const m = value.msb[w] >>> 0, l = value.lsb[w] >>> 0;
    if ((m & ~l) >>> 0) hasX = true;
    if ((m & l) >>> 0) hasZ = true;
  }
  if (hasX || hasZ) {
    const bitChar = (bit: number): string => {
      const l = bitOfWords(value.lsb, bit);
      const m = bitOfWords(value.msb, bit);
      if (m === 0) return l === 0 ? "0" : "1";
      return l === 0 ? "X" : "Z";
    };
    if (bitWidth === 1) return bitChar(0);
    let anyX = false, anyZ = false, anyDef = false;
    for (let bit = 0; bit < bitWidth; bit++) {
      const c = bitChar(bit);
      if (c === "X") anyX = true;
      else if (c === "Z") anyZ = true;
      else anyDef = true;
    }
    if ((radix === "hex" || radix === "dec" || radix === "sdec") && !anyDef && !(anyX && anyZ)) {
      return anyZ ? "Z" : "X";
    }
    if (radix === "hex") {
      const digits: string[] = [];
      for (let hi = bitWidth - 1; hi >= 0; hi -= 4) {
        let nib = 0, nibX = false, nibZ = false, allDef = true;
        for (let b = hi; b > hi - 4 && b >= 0; b--) {
          const c = bitChar(b);
          nib = (nib << 1) | (c === "1" ? 1 : 0);
          if (c === "X") { nibX = true; allDef = false; }
          else if (c === "Z") { nibZ = true; allDef = false; }
        }
        if (allDef) digits.push(nib.toString(16).toUpperCase());
        else if (nibX && nibZ) digits.push("X");
        else digits.push(nibZ ? "Z" : "X");
      }
      return `0x${digits.join("")}`;
    }
    const chars: string[] = [];
    for (let bit = bitWidth - 1; bit >= 0; bit--) chars.push(bitChar(bit));
    return `0b${chars.join("")}`;
  }
  if (enumLabels) {
    const label = enumLabels.get(value.lsb[0] >>> 0);
    if (label) return label;
  }
  if (bitWidth === 1) {
    // 1-bit two's complement: bit set is -1 (signed) or 1 (unsigned).
    if (radix === "sdec") return bitOfWords(value.lsb, 0) ? "-1" : "0";
    return String(bitOfWords(value.lsb, 0));
  }
  if (radix === "hex") {
    let hex = "";
    for (let hi = bitWidth - 1; hi >= 0; hi -= 4) {
      let nib = 0;
      for (let b = hi; b > hi - 4 && b >= 0; b--) nib = (nib << 1) | bitOfWords(value.lsb, b);
      hex += nib.toString(16).toUpperCase();
    }
    return `0x${hex.replace(/^0+/, "") || "0"}`;
  }
  if (radix === "dec" || radix === "sdec") {
    let big = 0n;
    for (let w = value.lsb.length - 1; w >= 0; w--) big = (big << 32n) | BigInt(value.lsb[w] >>> 0);
    big &= (1n << BigInt(bitWidth)) - 1n; // mask to width
    // Signed: re-interpret as two's complement when the sign bit is set.
    if (radix === "sdec" && (big & (1n << BigInt(bitWidth - 1)))) big -= 1n << BigInt(bitWidth);
    return big.toString();
  }
  let bin = "";
  for (let bit = bitWidth - 1; bit >= 0; bit--) bin += String(bitOfWords(value.lsb, bit));
  return `0b${bin}`;
}

// Enum label maps per row (value → label) for any enum-radix active signal —
// using the row's edited table if present, else the trace-derived one. Recomputed
// when the active set changes.
export function buildEnumLabels(active: ActiveSignalRef[]): Map<number, Map<number, string>> {
  const out = new Map<number, Map<number, string>>();
  for (const ref of active) {
    if (ref.radix !== "enum") continue;
    const table = enumTableForRef(ref);
    if (!table.length) continue;
    const m = new Map<number, string>();
    for (const e of table) m.set(e.value >>> 0, e.label);
    out.set(ref.row, m);
  }
  return out;
}
