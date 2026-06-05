"use strict";
// Seam C — native formatting + packing. Spawns lib/format-worker.cjs per fixture
// (isolated against panics) and asserts the decoded pill labels match the oracle's
// canonical `formatted` strings for every multi-bit, non-real signal/sample.

const { test, after } = require("node:test");
const assert = require("node:assert");
const path = require("node:path");
const fs = require("node:fs");
const { spawnSync } = require("node:child_process");
const { ORACLE_DIR } = require("./lib/oracle.cjs");

const WORKER = path.join(__dirname, "lib", "format-worker.cjs");
const oracleFiles = fs
  .readdirSync(ORACLE_DIR)
  .filter((f) => f.endsWith(".json"))
  .sort();

let totalChecked = 0;
let totalStyleOnly = 0;
let totalXz = 0;
const styleSamples = [];
const xzSamples = [];
const skips = { realValue: 0, overU32: 0, noLabel: 0, unsupportedRadix: 0 };
const crashed = [];

for (const f of oracleFiles) {
  const fixture = f.replace(/\.json$/, "");
  test(`format: ${fixture}`, () => {
    const r = spawnSync(process.execPath, [WORKER, path.join(ORACLE_DIR, f)], {
      encoding: "utf8",
      timeout: 60_000,
    });
    const line = (r.stdout || "").split("\n").find((l) => l.startsWith("RESULT:"));
    if (!line) {
      const why = (r.stderr || "").split("\n").slice(0, 2).join(" | ").trim();
      crashed.push(`${fixture}: ${why || "exit " + r.status}`);
      assert.fail(`${fixture}: addon crashed — ${why || "exit " + r.status}`);
    }
    const res = JSON.parse(line.slice("RESULT:".length));
    totalChecked += res.checked;
    totalStyleOnly += res.styleOnly || 0;
    totalXz += res.xzDiverge || 0;
    if (res.styleSample && styleSamples.length < 4) styleSamples.push(...res.styleSample);
    if (res.xzSample && xzSamples.length < 4) xzSamples.push(...res.xzSample);
    for (const k of Object.keys(skips)) skips[k] += res.skips[k] || 0;
    assert.strictEqual(
      res.errors.length,
      0,
      `${fixture}: ${res.errors.length} label mismatch(es):\n  ` +
        res.errors.slice(0, 12).join("\n  "),
    );
  });
}

after(() => {
  console.log(
    [
      "",
      "── format (seam C) summary ──",
      `  labels verified exact:        ${totalChecked}`,
      `  style-only divergences:       ${totalStyleOnly} (bit-equal; oracle=bare lowercase, riptide=0x UPPER)`,
      ...styleSamples.slice(0, 3).map((s) => `    · ${s}`),
      `  x/z hex spec divergences:     ${totalXz} (bits preserved; oracle collapses x/z, riptide shows per-nibble X/Z)`,
      ...xzSamples.slice(0, 3).map((s) => `    · ${s}`),
      `  skipped, real-valued signals: ${skips.realValue}`,
      `  skipped, unsupported radix:   ${skips.unsupportedRadix} (oct / dec-signed — riptide pack has no such mode)`,
      `  skipped, viewport > u32:      ${skips.overU32}`,
      `  skipped, no packed label:     ${skips.noLabel}`,
      crashed.length ? `  CRASHED: ${crashed.join("; ")}` : "  no crashes",
      "",
    ].join("\n"),
  );
});
