"use strict";
// Per-fixture worker for the seam-B/C native checks. Runs in its own process so a
// Zig @panic in the addon (which abort()s) only takes down this fixture, not the
// whole suite. Prints a single `RESULT:<json>` line; exits 0 even when assertions
// fail (failures travel in the JSON). A nonzero exit / missing RESULT line means
// the addon crashed or hung — the parent reports that as a crash.
//
// argv[2] = absolute path to oracle/<fixture>.json

const { loadOracle, loadAddon } = require("./oracle.cjs");
const { U32_MAX, decodeBits, buildPathMap, isBitString } = require("./decode.cjs");

const o = loadOracle(process.argv[2]);
const errors = [];
const skips = { overU32Time: 0, realValue: 0, nullValue: 0 };

const native = loadAddon();
native.loadVcd(o._vcdPath); // may panic -> process abort, caught by parent
const h = native.getHierarchy();
const { signals } = buildPathMap(h);

// hierarchy structure
for (const hn of o.hierarchy) {
  const sig = signals.get(hn.path);
  if (!sig) {
    errors.push(`hierarchy: missing path ${hn.path}`);
    continue;
  }
  if (sig.width !== hn.width) {
    errors.push(`hierarchy: ${hn.path} width ${sig.width} != oracle ${hn.width}`);
  }
}

// value_at over every case/signal/sample
for (const c of o.cases) {
  for (const [path, s] of Object.entries(c.signals)) {
    const sig = signals.get(path);
    if (!sig) {
      errors.push(`${c.name}: unresolved path ${path}`);
      continue;
    }
    for (const samp of s.samples) {
      const t = BigInt(samp.t);
      if (t > BigInt(U32_MAX)) {
        skips.overU32Time++;
        continue;
      }
      if (!isBitString(samp.raw)) {
        skips.realValue++;
        continue;
      }
      const v = native.getValueAt(sig.handle, Number(t));
      if (v == null) {
        skips.nullValue++;
        errors.push(`${c.name}: getValueAt(${path}, ${samp.t}) returned null`);
        continue;
      }
      const got = decodeBits(v, sig.width);
      if (got !== samp.raw) {
        errors.push(`${c.name}: ${path}@${samp.t} = ${got} != oracle ${samp.raw}`);
      }
    }
  }
}

process.stdout.write(
  "RESULT:" + JSON.stringify({ fixture: o.fixture, errors, skips }) + "\n",
);
