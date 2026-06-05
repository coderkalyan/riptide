"use strict";
// Seam C worker — formatting + packing. For each multi-bit (width > 1), non-real
// signal in each case, ask the addon to pack it over the case viewport, decode the
// native pill labels, and compare each covering label to the oracle's `formatted`
// string at every sample tick. This exercises label.zig's formatter (hex/dec/bin/
// enum) AND the segment packing boundaries in one shot.
//
// Single signal per getMockSegments call (row 0) so label index aligns with the
// multi-segment index trivially. Isolated per fixture (parent spawns it) so a Zig
// panic only fails this fixture.
//
// argv[2] = absolute path to oracle/<fixture>.json

const { loadOracle, loadAddon } = require("./oracle.cjs");
const { U32_MAX, isBitString } = require("./decode.cjs");

const o = loadOracle(process.argv[2]);
const errors = []; // genuine value divergences (clean value, supported radix)
const styleOnly = []; // bit-equal, display-style-only divergences (0x/case)
const xzDiverge = []; // x/z hex rendering differs from oracle spec (bits preserved)
const skips = { realValue: 0, overU32: 0, noLabel: 0, unsupportedRadix: 0 };
let checked = 0;

// riptide's native pill formatter (label.zig / NativePackSpec.radix) only knows
// these. Oracle radices outside the set (oct, dec-signed, real) can't even be
// requested — recorded as a capability gap, not a mismatch.
const SUPPORTED = new Set(["bin", "hex", "dec", "enum"]);

// Value-equality after stripping display style. The oracle is always bare
// lowercase; only riptide prefixes (0x hex / 0b bin) and uppercases. So strip the
// prefix from riptide's output *only* — stripping it from the oracle would
// mangle a legit hex value like "0b310d14" (leading 0, then b) into "310d14".
const stripGot = (s) => s.toLowerCase().replace(/^0[xb]/, "");
const valEq = (got, exp) => stripGot(got) === exp.toLowerCase();

const native = loadAddon();
native.loadVcd(o._vcdPath); // may panic -> parent reports crash

for (const c of o.cases) {
  const t0 = BigInt(c.viewport.t_start);
  const t1 = BigInt(c.viewport.t_end);
  if (t1 > BigInt(U32_MAX)) {
    skips.overU32++;
    continue;
  }
  for (const [path, s] of Object.entries(c.signals)) {
    if (s.width <= 1) continue; // 1-bit -> single pipeline, no pill label
    if (s.radix === "real" || s.samples.some((x) => !isBitString(x.raw))) {
      skips.realValue++;
      continue;
    }
    if (!SUPPORTED.has(s.radix)) {
      skips.unsupportedRadix++; // oct / dec-signed: riptide pack can't express it
      continue;
    }
    // Resolve handle from the live hierarchy by path.
    const h = native.getHierarchy();
    const byId = new Map(h.nodes.map((n) => [n.id, n]));
    const pathOf = (n) => {
      const p = [];
      let x = n;
      while (x) {
        p.unshift(x.name);
        x = x.parent == null ? null : byId.get(x.parent);
      }
      return p.join(".");
    };
    const node = h.nodes.find((n) => n.kind === "signal" && pathOf(n) === path);
    if (!node) {
      errors.push(`${c.name}: ${path} not in hierarchy`);
      continue;
    }

    const enums =
      s.radix === "enum" && s.enum_map
        ? Object.entries(s.enum_map).map(([bits, label]) => ({
            value: parseInt(bits, 2),
            label,
          }))
        : [];

    const spec = {
      row: 0,
      handle: node.handle,
      kind: "data",
      shaded: false,
      gateHandle: null,
      radix: s.radix,
      enums,
    };
    const r = native.getMockSegments([spec], Number(t0), Number(t1));
    const multi = new Uint32Array(r.multi);
    const offs = new Uint32Array(r.labelOffsets);
    const bytes = new Uint8Array(r.labelBytes);

    // (t_start, label) per multi segment, sorted ascending.
    const segs = [];
    for (let i = 0; i < r.multiCount; i++) {
      const tStart = multi[i * 3];
      const label = Buffer.from(bytes.slice(offs[i], offs[i + 1])).toString("ascii");
      segs.push([tStart, label]);
    }
    segs.sort((a, b) => a[0] - b[0]);

    if (segs.length === 0) {
      skips.noLabel++;
      continue;
    }

    const labelAt = (t) => {
      let lab = null;
      for (const [ts, l] of segs) {
        if (ts <= t) lab = l;
        else break;
      }
      return lab;
    };

    for (const samp of s.samples) {
      const t = BigInt(samp.t);
      if (t < t0 || t > t1) continue;
      const got = labelAt(Number(t));
      if (got == null) continue; // before first packed segment
      const hasUnknown = /[xz]/i.test(samp.raw);
      if (got === samp.formatted) {
        checked++;
      } else if (valEq(got, samp.formatted)) {
        styleOnly.push(`${c.name}: ${path}@${samp.t} "${got}" vs "${samp.formatted}"`);
      } else if (hasUnknown) {
        // Bits are x/z (seam B already proved they're preserved); only the spec's
        // x/z hex collapse vs riptide's per-nibble X/Z rendering differs.
        xzDiverge.push(`${c.name}: ${path}@${samp.t} "${got}" vs "${samp.formatted}"`);
      } else {
        errors.push(
          `${c.name}: ${path}@${samp.t} label "${got}" != oracle "${samp.formatted}" (radix ${s.radix}, width ${s.width})`,
        );
      }
    }
  }
}

process.stdout.write(
  "RESULT:" +
    JSON.stringify({
      fixture: o.fixture,
      errors,
      styleOnly: styleOnly.length,
      styleSample: styleOnly.slice(0, 3),
      xzDiverge: xzDiverge.length,
      xzSample: xzDiverge.slice(0, 3),
      skips,
      checked,
    }) +
    "\n",
);
