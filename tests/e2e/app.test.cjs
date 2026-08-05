"use strict";
// Seam D — end-to-end through the real Electron app (playwright-core drives the
// built renderer). Two kinds of check:
//
//   1. crash-smoke (all u32-range fixtures): launch on the fixture, wait for the
//      canvas + first frames, assert the renderer didn't crash and reported no
//      console error. Catches GPU-init / scene-build regressions per trace.
//   2. value cells (seeded fixtures): a sidecar pre-loads active signals + cursor;
//      assert each row's `.s-row .v` cell == the oracle's formatted value at the
//      cursor (value-normalized for 0x/case style). This exercises the full path:
//      native getValueAt -> JS formatSegmentValue -> DOM. These are also the only
//      launches with *active rows*, so they are where a bad pack spec surfaces —
//      hence the console assertion, which the value cells alone would not catch
//      (they come from getValueAt, which keeps working when the canvas does not).
//
// Needs a display. Run headless via `xvfb-run -a node --test tests/e2e/app.test.cjs`
// (or tests/run.sh). The pure-Node suites (native/format/malformed) need no display.

const { test, before, after } = require("node:test");
const assert = require("node:assert");
const path = require("node:path");
const fs = require("node:fs");
const { _electron: electron } = require("playwright-core");
const { listOracles } = require("../lib/oracle.cjs");
const { buildSeed, tmpRoot } = require("./seed.cjs");

const APP_ROOT = path.join(__dirname, "..", "..");
const U32 = 0xffffffff;
const LAUNCH_ARGS = ["--no-sandbox", "--enable-unsafe-webgpu", "--enable-features=Vulkan"];

// Fixtures whose whole span fits u32 (the others crash the addon at parse — a
// separate, already-reported bug; no point launching the app on them).
const oracles = listOracles().filter((o) => Number(BigInt(o.span)) <= U32);

const stripPfx = (s) => s.toLowerCase().replace(/^0[xb]/, "");
const noZeros = (s) => stripPfx(s).replace(/^0+(?=.)/, "");
// Classify a UI cell vs the oracle's formatted value:
//   exact     — identical
//   style     — only 0x prefix / letter case differ (bits + width identical)
//   pad       — additionally differ by leading-zero width padding (oracle pads to
//               full width; the UI JS formatter doesn't — a native↔JS desync)
//   mismatch  — genuinely different value
function classify(got, exp) {
  if (got === exp) return "exact";
  if (stripPfx(got) === exp.toLowerCase()) return "style";
  if (noZeros(got) === noZeros(exp)) return "pad";
  return "mismatch";
}

async function launch(vcd) {
  const app = await electron.launch({
    args: [APP_ROOT, ...LAUNCH_ARGS],
    env: { ...process.env, RIPTIDE_VCD: vcd },
    timeout: 60_000,
  });
  const win = await app.firstWindow();
  const errors = [];
  win.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  win.on("pageerror", (e) => errors.push(String(e)));
  return { app, win, errors };
}

// Console noise that is not the app's fault. Everything else fails the launch.
const fatalErrors = (errors) =>
  errors.filter((e) => !/DevTools|Autofill|Vulkan|GPU stall/i.test(e));

// ---- crash-smoke across all u32-range fixtures ----
for (const o of oracles) {
  test(`e2e smoke: ${o.fixture}`, async () => {
    const { app, win, errors } = await launch(o._vcdPath);
    try {
      await win.waitForSelector("canvas", { timeout: 30_000 });
      // Let a few frames run so GPU init / first pack actually executes.
      await win.waitForTimeout(1200);
      const alive = await win.evaluate(() => !!document.querySelector("canvas"));
      assert.ok(alive, `${o.fixture}: canvas vanished (renderer crash?)`);
      const fatal = fatalErrors(errors);
      assert.strictEqual(
        fatal.length,
        0,
        `${o.fixture}: console errors:\n  ` + fatal.slice(0, 6).join("\n  "),
      );
    } finally {
      await app.close();
    }
  });
}

// ---- seeded value-cell checks ----
const SEED_FIXTURES = ["smoke_basic", "sig_widths", "hier_balanced_soc"];
const root = tmpRoot();

for (const name of SEED_FIXTURES) {
  const o = oracles.find((x) => x.fixture === name);
  if (!o) continue;
  test(`e2e values: ${name}`, async () => {
    const seed = buildSeed(o, root);
    assert.ok(seed, `${name}: could not build a seed (no sidecar-radix signals)`);
    const { app, win, errors } = await launch(seed.vcd);
    try {
      await win.waitForSelector(".s-row", { timeout: 30_000 });
      await win.waitForTimeout(800);
      // Map rendered rows: signal name -> value cell text.
      const rendered = await win.evaluate(() =>
        Array.from(document.querySelectorAll(".s-row")).map((r) => ({
          name: r.querySelector(".n")?.textContent?.trim() ?? "",
          value: r.querySelector(".v")?.textContent?.trim() ?? "",
        })),
      );
      const byName = new Map(rendered.map((r) => [r.name, r.value]));

      const mismatches = [];
      const diverge = []; // style/pad — tracked, not failed
      for (const row of seed.rows) {
        const got = byName.get(row.name);
        if (got == null) {
          mismatches.push(`${row.path}: row not rendered`);
          continue;
        }
        const cls = classify(got, row.expected);
        if (cls === "mismatch") {
          mismatches.push(
            `${row.path}@cursor ${seed.cursor}: cell "${got}" != oracle "${row.expected}" (${row.radix})`,
          );
        } else if (cls !== "exact") {
          diverge.push(`${row.path}: "${got}" vs "${row.expected}" [${cls}]`);
        }
      }
      if (diverge.length) {
        console.log(`  [e2e ${name}] ${diverge.length} style/pad divergence(s): ${diverge.join("; ")}`);
      }
      assert.strictEqual(
        mismatches.length,
        0,
        `${name} (${seed.case}): ${mismatches.length} value-cell mismatch(es):\n  ` +
          mismatches.join("\n  ") +
          (errors.length ? `\n  [console] ${errors[0]}` : ""),
      );

      // These rows are active, so the renderer built pack specs and ran the
      // whole GPU path. A spec the addon rejects shows up only here: the value
      // cells above are fed by getValueAt and stay correct while the canvas is
      // dead behind them.
      const fatal = fatalErrors(errors);
      assert.strictEqual(
        fatal.length,
        0,
        `${name}: console errors with ${seed.rows.length} active rows:\n  ` +
          fatal.slice(0, 6).join("\n  "),
      );
    } finally {
      await app.close();
    }
  });
}

// ---- clock alignment on a trace with an SDI and no view sidecar ----
//
// Regression guard. "Align Grid to Clock" needs a row whose role is "clock"; the only
// source for that on a real trace is the SDI's `hints.role`, which native surfaces as
// `hintRole` and the renderer applies when a signal becomes active. When that plumbing
// was missing the control sat permanently disabled ("no clock-format signal to align
// to") on every trace without a hand-written sidecar.
//
// The assertion is the marker pill, not the toolbar button, and deliberately so: the
// button only reflects `clockAnchor`, which flips even when the detected grid is
// invalid. The pill renders `#<cycle>` ONLY when `clockAnchor && clockGrid.valid`, so
// it fails on both shapes of the bug — the control being dead, and the control
// appearing to work while the grid behind it is garbage.
test("e2e clock: SDI role hints make Align-to-Clock work without a sidecar", async () => {
  // Run against a COPY, in the temp root the seeded fixtures already use. Adding rows
  // arms the autosave, which writes `<trace>.sidecar.json` beside the trace — pointed
  // at samples/ that both litters the repo and destroys this test's own precondition
  // on the next run, since the second run would find the sidecar it wrote first.
  const src = path.join(APP_ROOT, "samples", "sdi", "gate.vcd");
  const dir = fs.mkdtempSync(path.join(root, "riptide-e2e-clock-"));
  const vcd = path.join(dir, "gate.vcd");
  fs.copyFileSync(src, vcd);
  fs.copyFileSync(`${src}.sdi.json`, `${vcd}.sdi.json`);
  assert.ok(!fs.existsSync(`${vcd}.sidecar.json`), "the copy must start with no view sidecar");

  const { app, win, errors } = await launch(vcd);
  try {
    await win.waitForSelector(".t-row", { timeout: 30_000 });
    // Add every signal the tree offers, the way a user would.
    await win.evaluate(() => {
      for (const r of document.querySelectorAll(".t-row")) r.querySelector(".plus")?.click();
    });
    await win.waitForSelector(".s-row", { timeout: 30_000 });
    await win.waitForTimeout(800);

    const clockBtn = ".btn.icon[data-tip='align grid to clock']";
    assert.ok(
      await win.$(clockBtn),
      "clock toggle should be enabled once a hinted clock is active (got: " +
        (await win.evaluate(() => {
          const b = [...document.querySelectorAll(".btn.icon")]
            .find((e) => /clock|timescale/.test(e.getAttribute("data-tip") || ""));
          return b ? `${b.className} / ${b.getAttribute("data-tip")}` : "no clock button";
        })) + ")",
    );

    // A marker reads in absolute time until the grid is aligned.
    await win.click(".btn.sm.icon[data-tip='add marker at cursor']");
    await win.waitForSelector(".marker-pill", { timeout: 10_000 });
    const before = await win.evaluate(() => document.querySelector(".marker-pill").textContent.trim());
    assert.ok(!/^#/.test(before), `marker should read absolute time before aligning, got "${before}"`);

    // Dispatched rather than hit-tested: the ClockPicker sits over the toggle and
    // intercepts a real pointer click, which is a layout detail, not what is under test.
    await win.evaluate((sel) => document.querySelector(sel).click(), clockBtn);
    await win.waitForTimeout(600);
    const after = await win.evaluate(() => document.querySelector(".marker-pill").textContent.trim());
    assert.match(
      after,
      /#\d+/,
      `marker should read a cycle index once aligned (grid detected + applied), got "${after}"`,
    );

    const fatal = fatalErrors(errors);
    assert.strictEqual(fatal.length, 0, `console errors:\n  ${fatal.slice(0, 6).join("\n  ")}`);
  } finally {
    await app.close();
  }
});

after(() => {
  // Best-effort cleanup of the temp seeds.
  try {
    fs.rmSync(root, { recursive: true, force: true });
  } catch {}
});
