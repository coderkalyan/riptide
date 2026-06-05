"use strict";
// Build an isolated, deterministic launch fixture for the Electron e2e: copy the
// target .vcd into a fresh temp dir and write a sidecar next to it seeding the
// active signals + cursor + time window. Launching on the temp copy keeps the
// app's autosave from clobbering the shared corpus.
//
// Returns { dir, vcd, sidecar, rows } where rows = the seeded signals with the
// oracle's expected formatted value at the cursor tick (for assertion).

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const PALETTE = ["#39b6ff", "#ff7a90", "#7ee787", "#f2cc60", "#d2a8ff", "#79c0ff"];
// Sidecar `radix` is limited to these (docs/sidecar.schema.json); enum/oct/
// dec-signed/real can't be seeded this way.
const SIDECAR_RADIX = new Set(["bin", "hex", "dec"]);

// Pick the oracle case + cursor tick: the first case whose viewport fits u32, and
// a sample tick near the middle of it that every seeded signal has a sample for.
function buildSeed(oracle, tmpRoot) {
  const U32 = 0xffffffff;
  const c = oracle.cases.find((cs) => Number(BigInt(cs.viewport.t_end)) <= U32);
  if (!c) return null;

  // Candidate signals: supported sidecar radix, value present at the chosen tick.
  const entries = Object.entries(c.signals).filter(([, s]) => SIDECAR_RADIX.has(s.radix));
  if (entries.length === 0) return null;

  // Cursor = a sample tick shared by the first signal (others may differ; we look
  // up each signal's own held value at that tick from its samples).
  const ticks = entries[0][1].samples.map((x) => x.t);
  const cursor = ticks[Math.floor(ticks.length / 2)];

  const heldAt = (s, t) => {
    // value held at t = last sample with sample.t <= t
    let v = null;
    for (const samp of s.samples) {
      if (BigInt(samp.t) <= BigInt(t)) v = samp;
      else break;
    }
    return v;
  };

  const rows = [];
  const sidecarSignals = [];
  entries.forEach(([p, s], i) => {
    const held = heldAt(s, cursor);
    if (!held) return;
    sidecarSignals.push({ path: p, radix: s.radix, color: PALETTE[i % PALETTE.length] });
    rows.push({ path: p, name: p.split(".").pop(), radix: s.radix, expected: held.formatted });
  });
  if (rows.length === 0) return null;

  const dir = fs.mkdtempSync(path.join(tmpRoot, `riptide-e2e-${oracle.fixture}-`));
  const vcd = path.join(dir, path.basename(oracle._vcdPath));
  fs.copyFileSync(oracle._vcdPath, vcd);

  const sidecar = `${vcd}.sidecar.json`;
  fs.writeFileSync(
    sidecar,
    JSON.stringify(
      {
        version: 1,
        view: {
          time: {
            start: Number(c.viewport.t_start),
            end: Number(c.viewport.t_end),
            cursor: Number(cursor),
          },
          signals: sidecarSignals,
        },
      },
      null,
      2,
    ),
  );

  return { dir, vcd, sidecar, cursor, case: c.name, rows };
}

function tmpRoot() {
  const r = path.join(os.tmpdir(), "riptide-e2e");
  fs.mkdirSync(r, { recursive: true });
  return r;
}

module.exports = { buildSeed, tmpRoot, SIDECAR_RADIX };
