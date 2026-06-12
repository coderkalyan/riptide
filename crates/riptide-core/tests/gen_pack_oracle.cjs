"use strict";
// Generates the Zig-oracle fixture for the Rust pack differential tests
// (pack_differential.rs). Runs the PRODUCTION napi addon's getMockSegments —
// the exact seam the old renderer consumed — over a set of spec/window cases
// against native/src/mock.vcd, and dumps every output buffer to JSON.
//
// Regenerate (after `pnpm install && pnpm build:native` at the repo root):
//
//   node crates/riptide-core/tests/gen_pack_oracle.cjs
//
// writes crates/riptide-core/tests/fixtures/pack_oracle.json. The fixture is
// committed so `cargo test -p riptide-core` stays hermetic (no zig/node on
// PATH needed); regenerate whenever mock.vcd or the Zig packer changes.

const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..", "..", "..");
const ADDON = path.join(ROOT, "dist", "native", "riptide.node");
const VCD = path.join(ROOT, "native", "src", "mock.vcd");
const OUT = path.join(__dirname, "fixtures", "pack_oracle.json");

if (!fs.existsSync(ADDON)) {
  console.error(`addon not built: ${ADDON} (run pnpm build:native)`);
  process.exit(1);
}
const native = require(ADDON);
native.loadVcd(VCD);

// path -> handle map, reconstructed from the live hierarchy (same walk as
// tests/lib/decode.cjs buildPathMap).
const h = native.getHierarchy();
const byId = new Map(h.nodes.map((n) => [n.id, n]));
const pathOf = (n) => {
  const parts = [];
  for (let c = n; c; c = c.parent == null ? null : byId.get(c.parent)) parts.unshift(c.name);
  return parts.join(".");
};
// The Zig hierarchy carries the VCD range suffix in vector names
// (`c[10:0]`); tide.rs uses the bare name. Key on the bare path.
const handles = new Map();
for (const n of h.nodes)
  if (n.kind === "signal") handles.set(pathOf(n).replace(/\[[^\]]*\]$/, ""), n.handle);

const handleOf = (p) => {
  const v = handles.get(p);
  if (v == null) throw new Error(`no signal at path ${p}`);
  return v;
};

const STATE_ENUMS = [
  { value: 0, label: "IDLE" },
  { value: 1, label: "LOAD" },
  { value: 2, label: "RUN" },
  { value: 3, label: "DONE" },
];

// A test spec: path-based; resolved to addon handles here and to tide.rs ids
// on the Rust side.
const row = (r, p, opts = {}) => ({
  row: r,
  path: p,
  kind: opts.kind ?? "data",
  polarity: opts.polarity ?? "rising",
  shaded: opts.shaded ?? false,
  mutePath: opts.mutePath ?? null,
  radix: opts.radix ?? "bin",
  enums: opts.enums ?? [],
});

const W = "top.keysched.waves.";
const CASES = [
  {
    name: "full_mixed",
    qStart: 0,
    qEnd: 90,
    specs: [
      row(0, "top.keysched.clk", { kind: "clk", polarity: "rising" }),
      row(1, "top.keysched.rst_n"),
      row(2, "top.keysched.c", { radix: "hex" }), // starts at x
      row(3, W + "in_addr", { radix: "hex" }),
      row(4, W + "wide_data", { radix: "hex" }), // 64-bit
      row(5, W + "dbus", { radix: "hex" }), // carries z
      row(6, W + "fifo_empty", { radix: "boolean" }), // labeled single, has x
      row(7, "top.keysched.state", { radix: "enum", enums: STATE_ENUMS }),
      row(8, W + "cycle_count", { radix: "dec", shaded: true }),
      row(9, W + "out_data", { radix: "sdec" }),
    ],
  },
  {
    name: "clk_polarities",
    qStart: 0,
    qEnd: 90,
    specs: [
      row(0, "top.keysched.clk", { kind: "clk", polarity: "rising" }),
      row(1, W + "clk", { kind: "clk", polarity: "falling" }),
      row(2, "top.keysched.clk", { kind: "clk", polarity: "both" }),
    ],
  },
  {
    name: "muted",
    qStart: 0,
    qEnd: 90,
    specs: [
      // mute edges (in_valid: 25/45/55/75, out_valid: 45/85) fall mid-segment
      // of these data signals, exercising the merged boundary walk.
      row(0, W + "out_data", { radix: "hex", mutePath: W + "in_valid" }),
      row(1, W + "wide_data", { radix: "hex", mutePath: W + "out_valid" }),
      row(2, W + "fifo_empty", { mutePath: W + "in_valid" }), // muted 1-bit line w/ x
      row(3, W + "in_data", { radix: "hex", mutePath: W + "in_valid" }), // aligned edges
      row(4, W + "in_addr", { radix: "hex" }), // unmuted control
    ],
  },
  {
    name: "window_mid",
    qStart: 30,
    qEnd: 60,
    specs: [
      row(0, "top.keysched.c", { radix: "hex" }),
      row(1, "top.keysched.clk", { kind: "clk", polarity: "rising" }),
      row(2, W + "out_data", { radix: "hex", mutePath: W + "in_valid" }),
      row(3, "top.keysched.rst_n"),
    ],
  },
  {
    name: "window_point",
    qStart: 40,
    qEnd: 40,
    specs: [
      row(0, W + "in_addr", { radix: "hex" }),
      row(1, "top.keysched.clk", { kind: "clk", polarity: "rising" }),
      row(2, W + "out_data", { radix: "hex", mutePath: W + "in_valid" }),
    ],
  },
  {
    name: "window_clamped",
    qStart: 0,
    qEnd: 1000000, // addon clamps to end_t (90)
    specs: [row(0, W + "in_addr", { radix: "hex" }), row(1, "top.keysched.rst_n")],
  },
  {
    name: "row_gaps",
    qStart: 0,
    qEnd: 90,
    specs: [
      row(1, "top.keysched.rst_n"),
      row(3, "top.keysched.c", { radix: "hex" }),
      row(7, "top.keysched.clk", { kind: "clk", polarity: "both" }),
    ],
  },
  {
    name: "single_only", // no multi rows: empty multi label stream
    qStart: 0,
    qEnd: 90,
    specs: [row(0, "top.keysched.rst_n"), row(1, "top.keysched.clk", { kind: "clk" })],
  },
];

const hex = (buf) => Buffer.from(buf).toString("hex");
const u32s = (buf) => Array.from(new Uint32Array(buf));
const segs = (buf, count) => {
  const w = new Uint32Array(buf);
  const out = [];
  for (let i = 0; i < count; i++) out.push([w[3 * i], w[3 * i + 1], w[3 * i + 2]]);
  return out;
};
const rowInfos = (buf, count) => {
  const w = new Uint32Array(buf);
  const out = [];
  for (let i = 0; i < count; i++) out.push(Array.from(w.subarray(7 * i, 7 * i + 7)));
  return out;
};

const cases = CASES.map((c) => {
  const specs = c.specs.map((s) => ({
    row: s.row,
    handle: handleOf(s.path),
    kind: s.kind,
    polarity: s.polarity,
    shaded: s.shaded,
    muteHandle: s.mutePath ? handleOf(s.mutePath) : null,
    radix: s.radix,
    enums: s.enums,
  }));
  const r = native.getMockSegments(specs, c.qStart, c.qEnd);
  return {
    name: c.name,
    qStart: c.qStart,
    qEnd: c.qEnd,
    specs: c.specs,
    expect: {
      multi: segs(r.multi, r.multiCount),
      single: segs(r.single, r.singleCount),
      rowInfos: rowInfos(r.rowInfo, r.rowCount),
      x0Pool: hex(r.x0Pool),
      x1Pool: hex(r.x1Pool),
      multiLabelBytes: Buffer.from(r.labelBytes).toString("latin1"),
      multiLabelOffsets: u32s(r.labelOffsets),
      singleLabelBytes: Buffer.from(r.singleLabelBytes).toString("latin1"),
      singleLabelOffsets: u32s(r.singleLabelOffsets),
      endTicks: r.endTicks,
    },
  };
});

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify({ vcd: "native/src/mock.vcd", cases }, null, 1) + "\n");
console.log(`wrote ${OUT} (${cases.length} cases)`);
