"use strict";
// Seam-B differential — the "through-addon" side. Given a fixture VCD and the
// zig-direct dump (id tick width x0hex x1hex, produced by native query-fixture),
// replay every (id, tick) through the production napi addon's getValueAt and
// assert the marshalled value is byte-identical to the pre-boundary bytes. No
// oracle: this catches any mutation the napi boundary introduces (word packing,
// truncation, byte order, x/z loss) regardless of value (METHODOLOGY §5).
//
// Isolated per fixture (parent spawns it): loadVcd panics on >u32 ticks.
//
// argv[2] = fixture vcd path, argv[3] = dump file path

const fs = require("node:fs");
const { loadAddon } = require("./oracle.cjs");
const { U32_MAX } = require("./decode.cjs");

const vcd = process.argv[2];
const dump = fs.readFileSync(process.argv[3], "utf8");

const native = loadAddon();
native.loadVcd(vcd); // may panic -> parent records crash

// Reconstruct the value's tide storage bytes from the addon's {lsb,msb} u32 word
// arrays exactly as jsWordArray packed them (little-endian), then hex them.
function planeHex(words, bps) {
  let s = "";
  for (let b = 0; b < bps; b++) {
    const byte = (words[b >>> 2] >>> ((b & 3) * 8)) & 0xff;
    s += byte.toString(16).padStart(2, "0");
  }
  return s;
}

const errors = [];
let checked = 0;
let skippedOverU32 = 0;

for (const line of dump.split("\n")) {
  if (!line) continue;
  const [idStr, tickStr, widthStr, x0hex, x1hex] = line.split(" ");
  const tick = BigInt(tickStr);
  if (tick > BigInt(U32_MAX)) {
    skippedOverU32++; // addon truncates tick to u32 — not comparable
    continue;
  }
  const width = parseInt(widthStr, 10);
  const bps = Math.ceil(width / 8);
  const v = native.getValueAt(idStr, Number(tick));
  if (v == null) {
    errors.push(`id ${idStr}@${tickStr}: addon returned null (zig-direct had a value)`);
    continue;
  }
  const gotX0 = planeHex(v.lsb, bps);
  const gotX1 = planeHex(v.msb, bps);
  if (gotX0 !== x0hex || gotX1 !== x1hex) {
    errors.push(
      `id ${idStr}@${tickStr} w${width}: addon (x0=${gotX0} x1=${gotX1}) != zig-direct (x0=${x0hex} x1=${x1hex})`,
    );
  } else {
    checked++;
  }
}

process.stdout.write(
  "RESULT:" + JSON.stringify({ errors, checked, skippedOverU32 }) + "\n",
);
