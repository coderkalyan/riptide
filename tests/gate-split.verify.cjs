"use strict";
// Ad-hoc verification: muted-data segment splitting. Synthesizes a VCD where the
// mute (enable) toggles BETWEEN the data signal's value changes, then checks that
// getMockSegments inserts a boundary at every mute edge AND every data edge, with
// the correct FLAG_MUTE per span. Run: node tests/gate-split.verify.cjs
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const ADDON = path.join(__dirname, "..", "dist", "native", "riptide.node");

// data8 (multi-bit, hex) holds 0xAA [0,40), 0xBB [40,80). en (1-bit enable) is
// 1 [0,10), 0 [10,30), 1 [30,55), 0 [55,80). So inside the FIRST data value (0xAA)
// the enable toggles at 10 and 30 — pure mute edges with no data change.
// Expected boundaries (data ∪ mute-flip): 0,10,30,40,55  (80 = end).
//   [0,10)  AA  unmuted
//   [10,30) AA  MUTED
//   [30,40) AA  unmuted
//   [40,55) BB  unmuted
//   [55,80) BB  MUTED
const vcd = `$version riptide-gate-test $end
$timescale 1ns $end
$scope module top $end
$var reg 8 ! data8[7:0] $end
$var reg 1 " en $end
$upscope $end
$enddefinitions $end
#0
$dumpvars
b10101010 !
1"
$end
#10
0"
#30
1"
#40
b10111011 !
#55
0"
#80
`;

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gate-split-"));
const vcdPath = path.join(dir, "g.vcd");
fs.writeFileSync(vcdPath, vcd);

const native = require(ADDON);
native.loadVcd(vcdPath);

const h = native.getHierarchy();
const sig = (name) =>
  h.nodes.find((n) => n.kind === "signal" && (n.name === name || n.name.startsWith(name + "[")));
const data = sig("data8");
const en = sig("en");

const spec = {
  row: 0,
  handle: data.handle,
  kind: "data",
  shaded: false,
  muteHandle: String(en.handle),
  radix: "hex",
  enums: [],
};

const r = native.getMockSegments([spec], 0, 80);
const multi = new Uint32Array(r.multi);
const offs = new Uint32Array(r.labelOffsets);
const bytes = new Uint8Array(r.labelBytes);

const FLAG_MUTE = 1 << 20;
const FLAG_RIGHT = 1 << 17;

const segs = [];
for (let i = 0; i < r.multiCount; i++) {
  const t_start = multi[i * 3];
  const t_end = multi[i * 3 + 1];
  const flags = multi[i * 3 + 2];
  const label = Buffer.from(bytes.slice(offs[i], offs[i + 1])).toString("ascii");
  segs.push({ t_start, t_end, muted: !!(flags & FLAG_MUTE), right: !!(flags & FLAG_RIGHT), label });
}
segs.sort((a, b) => a.t_start - b.t_start);

console.log("segments:");
for (const s of segs)
  console.log(
    `  [${s.t_start},${s.t_end}) ${s.muted ? "MUTED" : "ok   "} right=${s.right ? 1 : 0} label="${s.label}"`,
  );

const expect = [
  { t_start: 0, t_end: 10, muted: false, label: "0xAA" },
  { t_start: 10, t_end: 30, muted: true, label: "" },
  { t_start: 30, t_end: 40, muted: false, label: "0xAA" },
  { t_start: 40, t_end: 55, muted: false, label: "0xBB" },
  { t_start: 55, t_end: 80, muted: true, label: "" },
];

let ok = true;
if (segs.length !== expect.length) {
  ok = false;
  console.log(`FAIL: got ${segs.length} segments, expected ${expect.length}`);
}
for (let i = 0; i < Math.min(segs.length, expect.length); i++) {
  const g = segs[i], e = expect[i];
  const match =
    g.t_start === e.t_start && g.t_end === e.t_end && g.muted === e.muted && g.label === e.label;
  if (!match) {
    ok = false;
    console.log(
      `FAIL seg ${i}: got [${g.t_start},${g.t_end}) muted=${g.muted} "${g.label}" ` +
        `expected [${e.t_start},${e.t_end}) muted=${e.muted} "${e.label}"`,
    );
  }
}
console.log(ok ? "\nPASS" : "\nFAIL");
process.exit(ok ? 0 : 1);
