"use strict";
// Seam B — marshalling fidelity. For each oracle/<fixture>.json, spawn an isolated
// worker (lib/native-worker.cjs) that loads the production N-API addon, then
// asserts getHierarchy() widths + getValueAt() decoded bits against the oracle.
//
// Isolation is mandatory: a malformed-but-well-formed-looking input can trip a Zig
// @panic that abort()s the process. The worker confines that to one fixture; the
// parent reports it as a crash rather than letting it nuke the suite.
//
// Whole-corpus coverage gaps (the u32 time cap, real-valued signals) are summed
// and printed, not failed — see the report.

const { test, after } = require("node:test");
const assert = require("node:assert");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const { ORACLE_DIR } = require("./lib/oracle.cjs");

const WORKER = path.join(__dirname, "lib", "native-worker.cjs");
const oracleFiles = fs
  .readdirSync(ORACLE_DIR)
  .filter((f) => f.endsWith(".json"))
  .sort();

const totals = { overU32Time: 0, realValue: 0, nullValue: 0 };
const crashed = [];

for (const f of oracleFiles) {
  const fixture = f.replace(/\.json$/, "");
  test(`native: ${fixture}`, () => {
    const r = spawnSync(process.execPath, [WORKER, path.join(ORACLE_DIR, f)], {
      encoding: "utf8",
      timeout: 60_000,
    });

    if (r.error && r.error.code === "ETIMEDOUT") {
      crashed.push(`${fixture} (hang/timeout)`);
      assert.fail(`${fixture}: worker timed out (possible hang)`);
    }

    const line = (r.stdout || "").split("\n").find((l) => l.startsWith("RESULT:"));
    if (!line) {
      // No structured result => the addon crashed (panic/abort) before printing.
      const why = (r.stderr || "").split("\n").slice(0, 3).join(" | ").trim();
      crashed.push(`${fixture}: ${why || "no output, exit " + r.status}`);
      assert.fail(`${fixture}: addon crashed — ${why || "exit " + r.status}`);
    }

    const res = JSON.parse(line.slice("RESULT:".length));
    totals.overU32Time += res.skips.overU32Time;
    totals.realValue += res.skips.realValue;
    totals.nullValue += res.skips.nullValue;
    assert.strictEqual(
      res.errors.length,
      0,
      `${fixture}: ${res.errors.length} mismatch(es):\n  ` + res.errors.slice(0, 12).join("\n  "),
    );
  });
}

after(() => {
  console.log(
    [
      "",
      "── native (seam B) coverage gaps (tracked, not failed) ──",
      `  samples skipped, tick > u32 max: ${totals.overU32Time}`,
      `  samples skipped, real-valued:    ${totals.realValue}`,
      `  getValueAt null:                 ${totals.nullValue}`,
      crashed.length ? `  CRASHED fixtures: ${crashed.length}` : "  no crashes",
      ...crashed.map((c) => `    ✖ ${c}`),
      "",
    ].join("\n"),
  );
});
