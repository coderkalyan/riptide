"use strict";
// Shared decode + path-mapping helpers for the native (seam B/C) harnesses.
//
// riptide identifies signals by `handle` (a tide.Signal.Id as a decimal string)
// and exposes the hierarchy as a flat node list with parent ids; the oracle keys
// signals by dotted `path`. We bridge the two by reconstructing each signal's path
// from the live hierarchy (walk parents) and mapping path -> handle/width.

const U32_MAX = 0xffffffff;

// Decode a getValueAt() {lsb, msb} word pair into an MSB-first 4-state bit string
// of `width` chars. Per bit (m,l): (0,0)=0 (0,1)=1 (1,0)=x (1,1)=z — the same
// LSB/MSB convention the shader and formatSegmentValue use.
function decodeBits(v, width) {
  let s = "";
  for (let i = width - 1; i >= 0; i--) {
    const wi = (i / 32) | 0;
    const bit = i % 32;
    const l = (v.lsb[wi] >>> bit) & 1;
    const m = (v.msb[wi] >>> bit) & 1;
    s += m ? (l ? "z" : "x") : l ? "1" : "0";
  }
  return s;
}

// Build { path -> {handle, width, varType} } and a list of scope/signal entries
// from a live getHierarchy() result.
function buildPathMap(h) {
  const byId = new Map(h.nodes.map((n) => [n.id, n]));
  const pathOf = (n) => {
    const parts = [];
    let c = n;
    while (c) {
      parts.unshift(c.name);
      c = c.parent == null ? null : byId.get(c.parent);
    }
    return parts.join(".");
  };
  const signals = new Map();
  const scopes = new Set();
  for (const n of h.nodes) {
    const p = pathOf(n);
    if (n.kind === "signal") {
      signals.set(p, { handle: n.handle, width: n.bitWidth, varType: n.varType });
    } else {
      scopes.add(p);
    }
  }
  return { signals, scopes, pathOf };
}

// A bit string is a pure 4-state value (vs. a real, whose oracle "raw" is a
// decimal like "8.333"). Reals don't survive getValueAt's bit decode — callers
// skip them and we flag that gap.
const isBitString = (s) => /^[01xz]+$/.test(s);

module.exports = { U32_MAX, decodeBits, buildPathMap, isBitString };
