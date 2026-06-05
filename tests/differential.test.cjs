"use strict";
// Seam-B differential test. For each fixture: (1) run the native `query-fixture`
// exe to dump pack.valueAt() over the signals (zig-direct, pre-boundary), then
// (2) replay every sample through the napi addon and assert byte-equality. The two
// sides call the same Zig function on either side of the napi boundary, so a diff
// pins the boundary itself — no oracle authoring (METHODOLOGY §5).
//
// Both steps are spawned isolated: query-fixture and loadVcd both panic on >u32
// ticks, and an isolated crash is reported per fixture instead of killing the run.

const { test, after } = require("node:test");
const assert = require("node:assert");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const { spawnSync } = require("node:child_process");
const { VCD_TESTS_DIR, ORACLE_DIR } = require("./lib/oracle.cjs");

// Prefer a copy next to the addon (build:native), fall back to the zig build dir.
const QUERY_EXE = [
  path.join(__dirname, "..", "dist", "native", "query-fixture"),
  path.join(__dirname, "..", "native", "zig-out", "bin", "query-fixture"),
].find((p) => fs.existsSync(p));

const WORKER = path.join(__dirname, "lib", "differential-worker.cjs");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "riptide-diff-"));

const fixtures = fs
  .readdirSync(ORACLE_DIR)
  .filter((f) => f.endsWith(".json"))
  .map((f) => f.replace(/\.json$/, ""))
  .sort();

let totalChecked = 0;
let totalSkipped = 0;
const crashed = [];

test("differential: query-fixture exe is built", () => {
  assert.ok(QUERY_EXE, "native query-fixture exe not found — run `pnpm build:native`");
});

for (const fixture of fixtures) {
  test(`differential: ${fixture}`, (t) => {
    if (!QUERY_EXE) return t.skip("query-fixture not built");
    const vcd = path.join(VCD_TESTS_DIR, "fixtures", `${fixture}.vcd`);
    if (!fs.existsSync(vcd)) return t.skip(`missing ${vcd}`);
    const dumpFile = path.join(tmp, `${fixture}.txt`);

    // (1) zig-direct dump.
    const gen = spawnSync(QUERY_EXE, [vcd, dumpFile], { encoding: "utf8", timeout: 60_000 });
    if (gen.status !== 0 || !fs.existsSync(dumpFile)) {
      const why = (gen.stderr || "").split("\n").slice(0, 2).join(" | ").trim();
      crashed.push(`${fixture}: query-fixture ${why || "exit " + gen.status}`);
      assert.fail(`${fixture}: query-fixture crashed — ${why || "exit " + gen.status}`);
    }

    // (2) replay through the addon.
    const rep = spawnSync(process.execPath, [WORKER, vcd, dumpFile], {
      encoding: "utf8",
      timeout: 60_000,
    });
    const lineOut = (rep.stdout || "").split("\n").find((l) => l.startsWith("RESULT:"));
    if (!lineOut) {
      const why = (rep.stderr || "").split("\n").slice(0, 2).join(" | ").trim();
      crashed.push(`${fixture}: addon replay ${why || "exit " + rep.status}`);
      assert.fail(`${fixture}: addon replay crashed — ${why || "exit " + rep.status}`);
    }
    const res = JSON.parse(lineOut.slice("RESULT:".length));
    totalChecked += res.checked;
    totalSkipped += res.skippedOverU32;
    assert.strictEqual(
      res.errors.length,
      0,
      `${fixture}: ${res.errors.length} byte-divergence(s) at the napi boundary:\n  ` +
        res.errors.slice(0, 10).join("\n  "),
    );
  });
}

after(() => {
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch {}
  console.log(
    [
      "",
      "── seam-B differential (zig-direct vs through-addon, byte-equal) ──",
      `  samples byte-verified: ${totalChecked}`,
      `  skipped, tick > u32:   ${totalSkipped}`,
      crashed.length ? `  CRASHED: ${crashed.length}` : "  no crashes",
      ...crashed.map((c) => `    ✖ ${c}`),
      "",
    ].join("\n"),
  );
});
