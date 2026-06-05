"use strict";
// Malformed-input handling (METHODOLOGY §9). The ideal is a triple — survived,
// diagnosed (structured warning), partially correct. riptide has no error/warning
// channel yet, so the only HARD assertion here is **survival**: loadVcd must
// terminate within a wall-clock timeout (no hang). The outcome mode (loaded /
// threw / crashed) is recorded and printed so the gap between "didn't hang" and
// "diagnosed cleanly" is visible — a Zig @panic that abort()s is reported, not
// asserted away, because that is the current (un-implemented) behavior.

const { test, after } = require("node:test");
const assert = require("node:assert");
const path = require("node:path");
const fs = require("node:fs");
const { spawnSync } = require("node:child_process");
const { VCD_TESTS_DIR } = require("./lib/oracle.cjs");

const WORKER = path.join(__dirname, "lib", "malformed-worker.cjs");
const DIR = path.join(VCD_TESTS_DIR, "fixtures", "malformed");
const files = fs.existsSync(DIR)
  ? fs.readdirSync(DIR).filter((f) => f.endsWith(".vcd")).sort()
  : [];

const outcomes = [];

for (const f of files) {
  test(`malformed: ${f}  (survival only)`, () => {
    const r = spawnSync(process.execPath, [WORKER, path.join(DIR, f)], {
      encoding: "utf8",
      timeout: 30_000,
    });

    const hung = r.error && r.error.code === "ETIMEDOUT";
    const line = (r.stdout || "").split("\n").find((l) => l.startsWith("RESULT:"));

    let mode, detail;
    if (hung) {
      mode = "HANG";
      detail = "no termination within 30s";
    } else if (line) {
      const res = JSON.parse(line.slice("RESULT:".length));
      mode = res.mode; // loaded | threw
      detail =
        res.mode === "loaded"
          ? `nodes=${res.nodes} endTicks=${res.endTicks}`
          : res.message;
    } else {
      mode = "crashed";
      detail = (r.stderr || "").split("\n")[0].slice(0, 120) || `exit ${r.status}`;
    }
    outcomes.push({ f, mode, detail });

    // Hard requirement: it must not hang. A graceful throw is best; a panic/abort
    // (crashed) and a silent successful load are both reported but not failed —
    // error handling isn't implemented yet (see report).
    assert.ok(!hung, `${f}: loadVcd hung (${detail})`);
  });
}

after(() => {
  const rows = outcomes.map((o) => `  ${o.mode.padEnd(8)} ${o.f}  — ${o.detail}`);
  console.log(
    [
      "",
      "── malformed-input outcomes (survival asserted; diagnosis not yet implemented) ──",
      ...rows,
      "  legend: threw=graceful JS error | crashed=Zig panic/abort | loaded=parsed w/o complaint | HANG=fail",
      "",
    ].join("\n"),
  );
});
