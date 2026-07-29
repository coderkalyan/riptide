"use strict";
// Seam-B differential — the "through-addon" side. Given a fixture VCD and the
// direct dump (handle tick width x0hex x1hex, produced by query-fixture),
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

// Reconstruct the value's tide storage bytes from the addon's {lsb,msb,z} u32
// word arrays exactly as the addon packed them (little-endian), then hex them.
// getValueAt hands back the value plane and the unknown mask, so `max` is
// recovered by XOR — which is exactly the identity the addon relies on.
function planeByte(words, b) {
  return ((words?.[b >>> 2] ?? 0) >>> ((b & 3) * 8)) & 0xff;
}

function planeHex(words, bps, xorWith) {
  let s = "";
  for (let b = 0; b < bps; b++) {
    const byte = planeByte(words, b) ^ (xorWith ? planeByte(xorWith, b) : 0);
    s += byte.toString(16).padStart(2, "0");
  }
  return s;
}

const errors = [];
let checked = 0;
let skippedOverU32 = 0;

for (const line of dump.split("\n")) {
  if (!line) continue;
  const [idStr, tickStr, widthStr, minHex, maxHex, zHex] = line.split(" ");
  const tick = BigInt(tickStr);
  if (tick > BigInt(U32_MAX)) {
    skippedOverU32++; // addon truncates tick to u32 — not comparable
    continue;
  }
  const width = parseInt(widthStr, 10);
  const bps = Math.ceil(width / 8);
  const v = native.getValueAt(idStr, Number(tick));
  if (v == null) {
    errors.push(`id ${idStr}@${tickStr}: addon returned null (direct had a value)`);
    continue;
  }
  const gotMin = planeHex(v.lsb, bps);
  const gotMax = planeHex(v.lsb, bps, v.msb);
  const gotZ = planeHex(v.z, bps);
  if (gotMin !== minHex || gotMax !== maxHex || gotZ !== zHex) {
    errors.push(
      `id ${idStr}@${tickStr} w${width}: addon (min=${gotMin} max=${gotMax} z=${gotZ}) != ` +
        `direct (min=${minHex} max=${maxHex} z=${zHex})`,
    );
  } else {
    checked++;
  }
}

process.stdout.write(
  "RESULT:" + JSON.stringify({ errors, checked, skippedOverU32 }) + "\n",
);
