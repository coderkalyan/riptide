"use strict";
// Seam: the SDI format contract (docs/sdi.md, docs/sdi.schema.json).
//
// Guards the sample against the schema and the schema against the sample, then
// exercises the three questions the format exists to answer — what is this signal,
// who writes it, and what does it depend on — through the reference consumer
// (tools/sdi-cone.mjs). No native addon, no oracle corpus, no display: pure JSON.
//
// Schema validation needs an `ajv` binary; without one that single test skips and
// the rest still run (CI validates explicitly, see docs/sdi.md).

const { test } = require("node:test");
const assert = require("node:assert");
const path = require("node:path");
const fs = require("node:fs");
const { spawnSync } = require("node:child_process");

const ROOT = path.join(__dirname, "..");
const TOOL = path.join(ROOT, "tools", "sdi-cone.mjs");
const SCHEMA = path.join(ROOT, "docs", "sdi.schema.json");
const SDI = path.join(ROOT, "samples", "sdi", "gate.vcd.sdi.json");
const VCD = path.join(ROOT, "samples", "sdi", "gate.vcd");
const SRC = path.join(ROOT, "samples", "sdi", "gate.sv");

const sdi = () => JSON.parse(fs.readFileSync(SDI, "utf8"));

function run(...args) {
  const r = spawnSync(process.execPath, [TOOL, SDI, ...args], { encoding: "utf8", timeout: 60_000 });
  assert.strictEqual(r.status, 0, `sdi-cone ${args.join(" ")} exited ${r.status}: ${r.stderr}`);
  return r.stdout;
}

test("schema: sample validates (needs ajv)", (t) => {
  const ajv = ["node_modules/.bin/ajv", "node_modules/.bin/ajv.cmd"]
    .map((p) => path.join(ROOT, p))
    .find((p) => fs.existsSync(p));
  if (!ajv) return t.skip("no ajv binary — run `npx ajv-cli@5 validate --spec=draft2020 …`");
  const r = spawnSync(ajv, ["validate", "--spec=draft2020", "--strict=false", "-s", SCHEMA, "-d", SDI],
    { encoding: "utf8", timeout: 60_000 });
  assert.strictEqual(r.status, 0, `${r.stdout}${r.stderr}`);
});

test("schema: is parseable 2020-12 with the documented $id", () => {
  const s = JSON.parse(fs.readFileSync(SCHEMA, "utf8"));
  assert.strictEqual(s.$schema, "https://json-schema.org/draft/2020-12/schema");
  assert.strictEqual(s.$id, "https://riptide.dev/sdi.schema.json");
  assert.strictEqual(s.properties.version.const, 1);
});

test("spans point into the file they name", () => {
  const s = sdi();
  const lineCounts = s.files.map((f) => {
    const abs = path.join(path.dirname(SDI), f.path);
    return fs.readFileSync(abs, "utf8").split("\n").length;
  });
  let checked = 0;
  const walk = (node, key) => {
    if (Array.isArray(node)) {
      if ((key === "decl" || key === "loc" || key === "body") && typeof node[0] === "number") {
        const [file, line, , endLine] = node;
        assert.ok(s.files[file], `span names missing file ${file}`);
        assert.ok(line >= 1 && line <= lineCounts[file], `${key} line ${line} outside file`);
        if (endLine !== undefined) assert.ok(endLine >= line, `${key} ends before it starts`);
        checked++;
        return;
      }
      for (const v of node) walk(v, key);
    } else if (node && typeof node === "object") {
      for (const [k, v] of Object.entries(node)) walk(v, k);
    }
  };
  walk(s, "$");
  assert.ok(checked > 50, `expected the sample to carry spans, found ${checked}`);
});

// A digest catches source drift but needs a BLAKE3 implementation, which neither
// node:crypto nor the aux tools provide here. Anchoring representative spans to the
// text they must cover is the stronger guard anyway: it fails on the drift that
// actually matters (a span now pointing at the wrong code) rather than on any edit.
test("spans still cover the source they claim", () => {
  const s = sdi();
  const src = fs.readFileSync(path.join(path.dirname(SDI), s.files[0].path), "utf8").split("\n");
  const textAt = (span) => {
    const [, line, col, endLine, endCol] = span;
    if (endLine !== undefined && endLine !== line) return src.slice(line - 1, endLine).join("\n");
    return src[line - 1].slice((col ?? 1) - 1, endCol !== undefined ? endCol - 1 : undefined);
  };
  const unit = (name) => s.units.find((u) => u.name === name);
  const gate = unit("gate");
  const lane = unit("lane");
  assert.strictEqual(textAt(gate.decl), "gate");
  assert.match(textAt(gate.body), /^module gate[\s\S]*endmodule$/);
  assert.strictEqual(textAt(lane.vars[1].decl), "rst_n");
  assert.strictEqual(textAt(s.types[2].decl), "state_e");
  assert.strictEqual(textAt(s.types[2].values[2].decl), "DONE = 2'd3");
  assert.strictEqual(textAt(s.types[5].members[0].decl), "payload");
  const memWrite = gate.processes[0].assigns[0];
  assert.strictEqual(textAt(memWrite.loc), "mem[wptr] <= lane_out[0]");
  assert.strictEqual(textAt(lane.processes[0].assigns[0].loc), "nxt = state;");
});

test("source digest, when a BLAKE3 tool is available", (t) => {
  const f = sdi().files[0];
  const r = spawnSync("b3sum", ["--no-names", path.join(path.dirname(SDI), f.path)], { encoding: "utf8" });
  if (r.error || r.status !== 0) return t.skip("no b3sum — spans are guarded by content anchors instead");
  assert.strictEqual(r.stdout.trim(), f.blake3, "gate.sv changed without regenerating the sample SDI");
});

test("structural check passes and every ref resolves", () => {
  const out = run("check", VCD);
  assert.match(out, /all checks passed/);
  const refs = out.match(/refs resolved: (\d+)\/(\d+)/);
  assert.ok(refs, "check did not report ref resolution");
  assert.strictEqual(refs[1], refs[2], `unresolved refs: ${refs[0]}`);
});

test("binding: every variable resolves to a real VCD signal or is declared omitted", () => {
  const out = run("check", VCD);
  const m = out.match(/trace binding: (\d+) matched, (\d+) declared-omitted, (\d+) unexplained/);
  assert.ok(m, "check did not report trace binding");
  assert.ok(Number(m[1]) > 20, `expected most variables to bind, got ${m[1]}`);
  assert.strictEqual(m[3], "0", "some variables bound to nothing and were not declared omitted");
});

test("typed tree un-bins what VCD flattens", () => {
  const out = run("tree");
  // The VCD reports this as `reg 2`; SDI knows it is an enum with three members.
  assert.match(out, /state\s+2b pkt_pkg::state_e \{IDLE,BUSY,DONE\}/);
  // Unpacked arrays iverilog drops entirely are still in the tree, marked.
  assert.match(out, /mem\s+32b logic \[7:0\] \[0:3\]\s+\(memory not-in-trace\)/);
  // Generate iterations elaborate to distinct scopes.
  assert.match(out, /g_lane\[0\]/);
  assert.match(out, /g_lane\[1\]/);
  assert.match(out, /u_crc\s+\[blackBox\]/);
});

test("info: enum members, struct member offsets and trace candidates", () => {
  const enumInfo = run("info", "dut.g_lane[0].u_lane.state");
  assert.match(enumInfo, /0x3\s+DONE/);
  assert.match(enumInfo, /state \[1:0\]/); // the VCD spelling is offered as a candidate
  const structInfo = run("info", "dut.hdr");
  assert.match(structInfo, /payload\s+bits \[11:4\]/);
  assert.match(structInfo, /len\s+bits \[3:1\]/);
  assert.match(structInfo, /last\s+bits \[0:0\]/);
});

test("drivers: one write site per struct member, with source locations", () => {
  const out = run("drivers", "dut.hdr");
  assert.match(out, /gate\.sv:91:3[\s\S]*assign hdr\.payload = mem\[0\];/);
  assert.match(out, /gate\.sv:92:3[\s\S]*assign hdr\.len = 3'd4;/);
  assert.match(out, /gate\.sv:93:3[\s\S]*assign hdr\.last = \(st\[1\] == DONE\);/);
});

test("drivers: a clocked write is sequential, guarded, and its index is a source", () => {
  const out = run("drivers", "dut.mem");
  assert.match(out, /\(alwaysFF seq guarded approx\)/); // approx: mem[wptr] is a dynamic index
  assert.match(out, /wptr:index/);
  assert.match(out, /st\[1:0\]:control/);
  assert.match(out, /clk:clock/);
});

test("drivers: crossing a module boundary reaches the parent's connection", () => {
  const out = run("drivers", "dut.g_lane[0].u_lane.din");
  assert.match(out, /portIn/);
  assert.match(out, /\.din \(din\)/);
  assert.match(out, /tb\.dut\.din/);
});

test("readers: an assertion counts as a use with no target", () => {
  const out = run("readers", "dut.st");
  assert.match(out, /assertion/);
  assert.match(out, /gate\.sv:97/);
});

test("cone: same-cycle cone stops at flops", () => {
  const out = run("cone", "dut.sum");
  // Crosses the continuous assign, both generate blocks and both module boundaries.
  assert.match(out, /tb\.dut\.lane_out\[7:0\] ← tb\.dut\.g_lane\[0\]\.u_lane\.dout/);
  assert.match(out, /u_lane\.dout ← tb\.dut\.g_lane\[0\]\.u_lane\.acc/);
  // Reaches the flop and records it, but does not walk through it.
  assert.match(out, /u_lane\.acc ← tb\.dut\.g_lane\[0\]\.u_lane\.din\s+\(seq\)/);
  assert.doesNotMatch(out, /u_lane\.din ← tb\.dut\.din/);
});

test("cone: --cross-seq walks through flops to the primary input", () => {
  const out = run("cone", "dut.sum", "--cross-seq", "--data");
  assert.match(out, /u_lane\.din ← tb\.dut\.din/);
});

test("cone: a black box contributes conservative input-to-output edges", () => {
  const out = run("cone", "dut.sum");
  assert.match(out, /tb\.dut\.crc ← tb\.dut\.lane_out\[7:0\]\s+\(comb blackBox approx\)/);
});

test("cone: --data drops control dependence", () => {
  const all = run("cone", "dut.mem", "--cross-seq");
  const data = run("cone", "dut.mem", "--cross-seq", "--data");
  assert.match(all, /st\[1:0\]/, "control dependence on st should appear by default");
  assert.doesNotMatch(data, /:control/);
});

test("fanout: forward cone from a primary input reaches both lanes", () => {
  const out = run("fanout", "dut.din", "--cross-seq");
  assert.match(out, /tb\.dut\.din → tb\.dut\.g_lane\[0\]\.u_lane\.din/);
  assert.match(out, /tb\.dut\.din → tb\.dut\.g_lane\[1\]\.u_lane\.din/);
  assert.match(out, /u_lane\.acc → tb\.dut\.g_lane\[0\]\.u_lane\.dout/);
});

test("sample source still lints clean under verilator", (t) => {
  const r = spawnSync("verilator", [
    "--lint-only", "--assert", "-Wno-DECLFILENAME", "-Wno-UNUSEDSIGNAL",
    SRC, path.join(path.dirname(SRC), "crc8.sv"), "--top-module", "gate",
  ], { encoding: "utf8", timeout: 60_000 });
  if (r.error) return t.skip("verilator not installed");
  assert.strictEqual(r.status, 0, r.stderr);
});

// ---------------------------------------------------------------------------
// Producer round-trip: Verilator -> SDI -> the same answers as the hand-authored
// file. This is what keeps the schema honest about being fillable from a real
// front end rather than only by hand.
//
// The producer is `crates/sdi-verilator`, built on demand. These tests skip when
// either verilator or cargo is missing, so the suite stays headless and toolchain
// -optional like the rest of tests/run.sh.

const SAMPLE_DIR = path.dirname(SDI);
let producerPath;

function producer(t) {
  if (producerPath !== undefined) return producerPath;
  producerPath = null;
  if (spawnSync("verilator", ["--version"], { encoding: "utf8" }).error) return null;
  if (spawnSync("cargo", ["--version"], { encoding: "utf8" }).error) return null;
  const build = spawnSync("cargo", ["build", "--release", "--package", "sdi-verilator"], {
    cwd: ROOT,
    encoding: "utf8",
    timeout: 600_000,
  });
  if (build.status !== 0) {
    assert.fail(`cargo build -p sdi-verilator failed:\n${build.stderr}`);
  }
  const exe = path.join(ROOT, "target", "release", "sdi-verilator");
  producerPath = fs.existsSync(exe) ? exe : null;
  return producerPath;
}

function generate(t, extraArgs = []) {
  const exe = producer(t);
  if (!exe) return t.skip("needs verilator + cargo");
  const dir = fs.mkdtempSync(path.join(require("node:os").tmpdir(), "sdi-gen-"));
  const v = spawnSync("verilator", [
    "--json-only", "--assert", "-Wno-DECLFILENAME", "-Wno-UNUSEDSIGNAL",
    "--Mdir", dir, path.join(SAMPLE_DIR, "gate.sv"), path.join(SAMPLE_DIR, "crc8.sv"),
    "--top-module", "gate",
  ], { encoding: "utf8", timeout: 60_000 });
  assert.strictEqual(v.status, 0, v.stderr);
  const out = path.join(dir, "gen.sdi.json");
  const g = spawnSync(exe, [
    path.join(dir, "Vgate.tree.json"), "--out", out,
    "--trace", path.join(SAMPLE_DIR, "gate.vcd"),
    "--root-prefix", "tb", "--root-name", "dut", "--source-root", SAMPLE_DIR,
    "--quiet", ...extraArgs,
  ], { encoding: "utf8", timeout: 60_000 });
  assert.strictEqual(g.status, 0, g.stderr);
  return out;
}

function coneOf(file, ...args) {
  const r = spawnSync(process.execPath, [TOOL, file, ...args], { encoding: "utf8", timeout: 60_000 });
  assert.strictEqual(r.status, 0, r.stderr);
  return r.stdout;
}

test("producer: verilator output passes the same structural check", (t) => {
  const file = generate(t, ["--unpacked-arrays", "omit"]);
  if (!file) return;
  const out = coneOf(file, "check", VCD);
  assert.match(out, /all checks passed/);
  const refs = out.match(/refs resolved: (\d+)\/(\d+)/);
  assert.strictEqual(refs[1], refs[2]);
  const bind = out.match(/trace binding: (\d+) matched, (\d+) declared-omitted, (\d+) unexplained/);
  assert.strictEqual(bind[3], "0", "generated SDI left trace signals unexplained");
});

test("producer: computes the facts verilator does not emit", (t) => {
  const file = generate(t);
  if (!file) return;
  const gen = JSON.parse(fs.readFileSync(file, "utf8"));
  // Widths: absent from verilator's JSON entirely, so every bit type must carry one.
  for (const ty of gen.types) {
    if (["bits", "enum", "real"].includes(ty.kind)) {
      assert.ok(Number.isInteger(ty.width), `${ty.kind} ${ty.name ?? ""} has no width`);
    }
  }
  // Packed struct member offsets: also absent upstream.
  const pkt = gen.types.find((t2) => t2.kind === "struct" && t2.packed);
  assert.ok(pkt, "packed struct not modelled");
  assert.deepStrictEqual(pkt.members.map((m) => m.lsb), [4, 1, 0]);
  assert.strictEqual(pkt.width, 12);
  // 2- vs 4-state, which VCD bins together.
  assert.ok(gen.types.some((t2) => t2.states === 2), "no 2-state type recovered");
  // Doc comments: no surveyed front end exports them; recovered from source.
  const lane = gen.units.find((u) => u.name === "lane");
  assert.strictEqual(lane.vars.find((v) => v.name === "rst_n").comment, "active-low reset");
  assert.match(gen.types.find((t2) => t2.name === "state_e").comment, /Lane state/);
  // Body extents: verilator emits only the identifier location.
  assert.ok(lane.body && lane.body[3] > lane.body[1], "unit body is not a real extent");
});

test("producer: same cone as the hand-authored SDI, refined where it knows more", (t) => {
  const file = generate(t, ["--unpacked-arrays", "omit"]);
  if (!file) return;
  const gen = coneOf(file, "cone", "dut.sum");
  // Identical structure through the generate blocks and module boundaries.
  for (const re of [
    /tb\.dut\.sum ← tb\.dut\.lane_out\[7:0\]/,
    /tb\.dut\.lane_out\[15:8\] ← tb\.dut\.g_lane\[1\]\.u_lane\.dout/,
    /u_lane\.dout ← tb\.dut\.g_lane\[0\]\.u_lane\.acc/,
    /u_lane\.acc ← tb\.dut\.g_lane\[0\]\.u_lane\.state\s+\(seq control\)/,
    /u_lane\.acc ← tb\.dut\.g_lane\[0\]\.u_lane\.clk\s+\(seq clock\)/,
  ]) assert.match(gen, re, `generated cone missing ${re}`);
  // The hand-authored file models u_crc as a black box; verilator was given its
  // source, so the generated cone resolves the real bit-level path instead.
  assert.match(gen, /u_crc\.crc ← tb\.dut\.u_crc\.data\[6:0\]/);
  assert.doesNotMatch(gen, /blackBox/);
});

test("producer: --unpacked-arrays elements maps each element to its own signal", (t) => {
  const file = generate(t, ["--unpacked-arrays", "elements"]);
  if (!file) return;
  const gen = JSON.parse(fs.readFileSync(file, "utf8"));
  const gate = gen.units.find((u) => u.name === "gate");
  const mem = gate.vars.find((v) => v.name === "mem");
  assert.deepStrictEqual(mem.traceSignals.map((s) => s.path), ["mem[0]", "mem[1]", "mem[2]", "mem[3]"]);
  assert.deepStrictEqual(mem.traceSignals.map((s) => s.bits), [[0, 8], [8, 8], [16, 8], [24, 8]]);
});

// ---------------------------------------------------------------------------
// The bundled mock ships its own hand-authored SDI, which is what makes the demo
// trace show source integration. Guarded the same way samples/sdi is: it must
// validate, and every one of its variables must bind to a real signal in the
// trace it was written for.

const MOCK_SDI = path.join(ROOT, "native", "src", "mock.vcd.sdi.json");
const MOCK_VCD = path.join(ROOT, "native", "src", "mock.vcd");
const MOCK_SV = path.join(ROOT, "native", "src", "mock.sv");

test("mock: its SDI binds every variable to the bundled trace", () => {
  const r = spawnSync(process.execPath, [TOOL, MOCK_SDI, "check", MOCK_VCD], {
    encoding: "utf8",
    timeout: 60_000,
  });
  assert.strictEqual(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /all checks passed/);
  const bind = r.stdout.match(/trace binding: (\d+) matched, (\d+) declared-omitted, (\d+) unexplained/);
  assert.ok(bind, "no binding line");
  assert.strictEqual(bind[3], "0", "some mock signals bound to nothing");
  assert.ok(Number(bind[1]) >= 36, `only ${bind[1]} matched`);
});

test("mock: its spans still cover the declarations they name", () => {
  const doc = JSON.parse(fs.readFileSync(MOCK_SDI, "utf8"));
  const src = fs.readFileSync(MOCK_SV, "utf8").split("\n");
  const textAt = (span) => {
    const [, line, col, endLine, endCol] = span;
    if (endLine !== undefined && endLine !== line) return src.slice(line - 1, endLine).join("\n");
    return src[line - 1].slice((col ?? 1) - 1, endCol !== undefined ? endCol - 1 : undefined);
  };
  const unit = (name) => doc.units.find((u) => u.name === name);
  assert.strictEqual(textAt(unit("waves").decl), "waves");
  assert.match(textAt(unit("waves").body), /^module waves \([\s\S]*endmodule$/);
  const rstN = unit("keysched").vars.find((v) => v.name === "rst_n");
  assert.strictEqual(textAt(rstN.decl), "rst_n");
  assert.strictEqual(rstN.comment, "active-low reset");
  const stateType = doc.types.find((t) => t.name === "state_e");
  assert.strictEqual(textAt(stateType.decl), "state_e");
  assert.deepStrictEqual(stateType.values.map((v) => v.name), ["IDLE", "BUSY", "WAIT"]);
});

test("mock: the source still lints clean", (t) => {
  const r = spawnSync("verilator", [
    "--lint-only", MOCK_SV, "--top-module", "top",
    "-Wno-DECLFILENAME", "-Wno-PINMISSING", "-Wno-UNDRIVEN", "-Wno-UNUSEDSIGNAL", "-Wno-ASCRANGE",
  ], { encoding: "utf8", timeout: 60_000 });
  if (r.error) return t.skip("verilator not installed");
  assert.strictEqual(r.status, 0, r.stderr);
});
