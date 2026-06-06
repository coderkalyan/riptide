"use strict";
// Minimal dependency-free PNG decode + pixel diff for the visual-regression
// harness (visual.test.cjs). playwright-core ships no screenshot matcher and we
// don't want a pixelmatch/pngjs dependency, so we decode the two PNGs to raw
// RGBA with node's zlib and count differing pixels ourselves.
//
// Supports the only thing Playwright emits: 8-bit, non-interlaced, colour type
// 6 (RGBA) or 2 (RGB). Throws on anything else so a format surprise is loud.

const zlib = require("node:zlib");

const SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function decode(buf) {
  if (!buf.subarray(0, 8).equals(SIG)) throw new Error("not a PNG");
  let off = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let interlace = 0;
  const idat = [];

  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString("ascii", off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      interlace = data[12];
    } else if (type === "IDAT") {
      idat.push(data);
    } else if (type === "IEND") {
      break;
    }
    off += 12 + len; // length + type + data + crc
  }

  if (bitDepth !== 8 || interlace !== 0 || (colorType !== 6 && colorType !== 2)) {
    throw new Error(`unsupported PNG (depth=${bitDepth} color=${colorType} interlace=${interlace})`);
  }

  const channels = colorType === 6 ? 4 : 3;
  const stride = width * channels;
  const raw = zlib.inflateSync(Buffer.concat(idat));
  // Output is always RGBA so the diff loop is uniform.
  const out = Buffer.alloc(width * height * 4);
  const line = Buffer.alloc(stride);
  const prev = Buffer.alloc(stride);
  let p = 0;

  const paeth = (a, b, c) => {
    const pp = a + b - c;
    const pa = Math.abs(pp - a);
    const pb = Math.abs(pp - b);
    const pc = Math.abs(pp - c);
    return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
  };

  for (let y = 0; y < height; y++) {
    const filter = raw[p++];
    for (let x = 0; x < stride; x++) {
      const cur = raw[p++];
      const a = x >= channels ? line[x - channels] : 0;
      const b = prev[x];
      const c = x >= channels ? prev[x - channels] : 0;
      let val;
      switch (filter) {
        case 0: val = cur; break;
        case 1: val = cur + a; break;
        case 2: val = cur + b; break;
        case 3: val = cur + ((a + b) >> 1); break;
        case 4: val = cur + paeth(a, b, c); break;
        default: throw new Error(`bad filter ${filter} on row ${y}`);
      }
      line[x] = val & 0xff;
    }
    // Expand the unfiltered scanline into RGBA.
    const base = y * width * 4;
    for (let x = 0; x < width; x++) {
      const si = x * channels;
      const di = base + x * 4;
      out[di] = line[si];
      out[di + 1] = line[si + 1];
      out[di + 2] = line[si + 2];
      out[di + 3] = channels === 4 ? line[si + 3] : 0xff;
    }
    line.copy(prev);
  }

  return { width, height, data: out };
}

// Count pixels whose max per-channel delta exceeds `threshold` (0..255).
// Returns { width, height, diffPixels, total, sizeMismatch }.
function diff(aBuf, bBuf, threshold = 0) {
  const a = decode(aBuf);
  const b = decode(bBuf);
  if (a.width !== b.width || a.height !== b.height) {
    return { width: a.width, height: a.height, diffPixels: -1, total: 0, sizeMismatch: true };
  }
  const total = a.width * a.height;
  let diffPixels = 0;
  for (let i = 0; i < total; i++) {
    const o = i * 4;
    const dr = Math.abs(a.data[o] - b.data[o]);
    const dg = Math.abs(a.data[o + 1] - b.data[o + 1]);
    const db = Math.abs(a.data[o + 2] - b.data[o + 2]);
    const da = Math.abs(a.data[o + 3] - b.data[o + 3]);
    if (Math.max(dr, dg, db, da) > threshold) diffPixels++;
  }
  return { width: a.width, height: a.height, diffPixels, total, sizeMismatch: false };
}

module.exports = { decode, diff };
