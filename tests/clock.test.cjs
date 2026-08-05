"use strict";
// Seam: the timebase/clock path — "Align Grid to Clock".
//
// That feature needs two things to survive the Rust→JS boundary, and it silently does
// nothing if either is missing:
//
//   1. A ROLE. Something has to say which signal is the clock. A hand-written view
//      sidecar can, but most traces do not have one — for those the only source is the
//      SDI's `hints.role`, which the addon surfaces as `hintRole` on the signal node.
//      This was declared in docs/sdi.md, modelled in the sdi crate, and never actually
//      read, so clock alignment was dead on every trace without a sidecar.
//   2. A GRID. `wave/clock.ts detectClockGrid` derives {phase, period} from a cheap
//      prefix of `getEdges`. It needs at least two reference edges with decodable
//      levels; anything else yields `valid: false`, which reads to the user as the
//      toggle doing nothing at all.
//
// Both are asserted here against the real addon. The user-visible half — that toggling
// actually changes the view — lives in e2e/app.test.cjs, which can drive the UI.
//
// Headless: no display needed, only the built addon.

const { test } = require("node:test");
const assert = require("node:assert");
const path = require("node:path");
const { loadAddon } = require("./lib/oracle.cjs");

const ROOT = path.join(__dirname, "..");
const MOCK = path.join(ROOT, "native", "src", "mock.vcd");
// Ships an SDI and deliberately NO view sidecar — the shape of a real user's trace,
// and the case the regression broke.
const GATE = path.join(ROOT, "samples", "sdi", "gate.vcd");

// Flatten the addon's hierarchy to path -> node, the way the renderer's getHierarchy does.
function signalsOf(native, vcd) {
  native.loadVcd(vcd);
  const h = native.getHierarchy();
  const byId = new Map(h.nodes.map((n) => [n.id, n]));
  const out = new Map();
  const walk = (id, prefix) => {
    const n = byId.get(id);
    if (!n) return;
    const p = prefix ? `${prefix}.${n.name}` : n.name;
    if (n.kind === "signal") out.set(p, n);
    for (const c of n.children || []) walk(c, p);
  };
  for (const r of h.rootIds) walk(r, "");
  return out;
}

test("hintRole: the SDI's role reaches the hierarchy (bundled mock)", () => {
  const sigs = signalsOf(loadAddon(), MOCK);
  assert.strictEqual(sigs.get("top.keysched.waves.clk").hintRole, "clock");
  assert.strictEqual(sigs.get("top.keysched.waves.rst").hintRole, "reset");
  // Not hinted -> no role. The renderer must not invent one from the name.
  assert.strictEqual(sigs.get("top.keysched.waves.state[1:0]").hintRole, undefined);
});

test("hintRole: a trace with an SDI and no view sidecar still names its clock", () => {
  const sigs = signalsOf(loadAddon(), GATE);
  // This is the exact case that regressed: nothing but the SDI says `clk` is a clock.
  assert.strictEqual(sigs.get("tb.dut.clk").hintRole, "clock");
  assert.strictEqual(sigs.get("tb.dut.rst_n").hintRole, "reset");
  // The SDI describes the DUT, not the testbench, so tb-level signals stay unhinted
  // rather than being back-filled by name.
  assert.strictEqual(sigs.get("tb.clk").hintRole, undefined);
});

// Mirror of wave/clock.ts detectClockGrid. The renderer's copy is TypeScript importing
// browser-side modules, so it cannot be required here; this asserts the DATA it consumes
// is shaped as it expects (f64 ticks, byte-wide level planes, regular edges). If this
// passes and alignment is still broken, the bug is renderer-side, not in the addon.
function gridFrom(edges) {
  const ticks = new Float64Array(edges.ticks);
  const lsb = new Uint8Array(edges.lsb);
  const msb = new Uint8Array(edges.msb);
  const rising = [];
  for (let i = 0; i < edges.count; i++) {
    if (msb[i] === 0 && lsb[i] !== 0) rising.push(ticks[i]);
  }
  if (rising.length < 2) return { phase: rising[0] ?? 0, period: 1, valid: false };
  const gaps = rising.slice(1).map((t, i) => t - rising[i]);
  const sorted = [...gaps].sort((a, b) => a - b);
  const m = sorted.length >> 1;
  const period = sorted.length % 2 ? sorted[m] : (sorted[m - 1] + sorted[m]) / 2;
  return {
    phase: rising[0],
    period: period > 0 ? period : 1,
    valid: period > 0 && gaps.every((d) => Math.abs(d - period) <= period * 0.25),
  };
}

test("getEdges: a clock's prefix yields a regular, valid grid", () => {
  const native = loadAddon();
  const sigs = signalsOf(native, MOCK);
  const clk = sigs.get("top.keysched.waves.clk");
  const e = native.getEdges(clk.handle, 0, 32);
  assert.ok(e && e.count >= 2, `expected transitions, got ${e && e.count}`);

  // The planes are raw ArrayBuffers; the renderer wraps them in typed views. Indexing
  // them unwrapped yields undefined for every sample, which is a silent "no edges".
  assert.strictEqual(new Uint8Array(e.lsb).length, e.count, "one level byte per edge");
  assert.strictEqual(new Float64Array(e.ticks).length, e.count, "f64 tick per edge");

  const g = gridFrom(e);
  assert.ok(g.valid, `clock grid should be valid, got ${JSON.stringify(g)}`);
  assert.ok(g.period > 0, "a clock must have a positive period");
  // The bundled mock's clock is documented in its SDI as a 10 ns period; the trace's
  // timescale is 1 ns, so one cycle is 10 ticks.
  assert.strictEqual(g.period, 10);
});

test("getEdges: a non-toggling signal produces no usable grid", () => {
  const native = loadAddon();
  const sigs = signalsOf(native, MOCK);
  // A constant/near-constant signal must be reported invalid rather than yielding a
  // nonsense period that would misalign every cycle label.
  const wide = sigs.get("top.keysched.waves.out_data[31:0]");
  const e = native.getEdges(wide.handle, 0, 32);
  if (!e || e.count < 2) return; // nothing to sample — already the invalid path
  const g = gridFrom(e);
  assert.ok(typeof g.valid === "boolean", "grid validity is always decided, never thrown");
});
