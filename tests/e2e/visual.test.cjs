"use strict";
// Visual-regression harness for the DOM chrome (the CSS migration's safety net).
//
// Launches the real built Electron app via playwright-core, drives it into a
// matrix of UI states, and screenshots the full window with the WebGPU canvas
// MASKED (its pixels are GPU-rendered, out of scope, and nondeterministic). Each
// shot is compared against a committed golden PNG; any chrome change fails the
// test. This proves the Tailwind migration is visually a no-op.
//
//   node --test tests/e2e/visual.test.cjs            # compare to goldens
//   UPDATE_GOLDENS=1 node --test tests/e2e/visual.test.cjs   # (re)write goldens
//
// Needs a display (this repo's e2e already assumes one — DISPLAY or xvfb). Build
// first (`pnpm build`) so dist/ is current. Determinism knobs: fixed content
// size per state, fixed device-scale-factor=1, fonts.ready await, settle delay,
// Playwright animations:'disabled' + caret:'hide', and the canvas mask.
//
// Tolerance via env. Defaults absorb sub-pixel text-AA rasterization jitter
// (observed: a handful of pixels per frame, per-channel delta <=17, almost all
// <=4) while still catching real changes (glyph/colour/layout shifts span
// thousands of high-delta pixels, and a subtle global colour shift trips the low
// per-channel threshold over a large area). VISUAL_CHANNEL = per-channel delta
// that counts as "different"; VISUAL_RATIO = max fraction of differing pixels.

const { test, before, after } = require("node:test");
const assert = require("node:assert");
const path = require("node:path");
const fs = require("node:fs");
const { _electron: electron } = require("playwright-core");
const { diff } = require("./pngdiff.cjs");

const APP_ROOT = path.join(__dirname, "..", "..");
const MOCK_VCD = path.join(APP_ROOT, "native", "src", "mock.vcd");
const GOLDEN_DIR = path.join(__dirname, "golden", "visual");
const UPDATE = process.env.UPDATE_GOLDENS === "1";
const CHANNEL = Number(process.env.VISUAL_CHANNEL ?? 8);
const RATIO = Number(process.env.VISUAL_RATIO ?? 0.00006);

const LAUNCH_ARGS = [
  "--no-sandbox",
  "--enable-unsafe-webgpu",
  "--enable-features=Vulkan",
  "--force-device-scale-factor=1",
];

// State matrix. `size` sets the rendered viewport (via CDP device-metrics
// override — see setSizeAndSettle). `env` overrides launch env. `setup` runs page
// interactions after load; `ready` is the selector that proves the state is
// rendered before we screenshot.
const STATES = [
  { name: "loaded", size: [1400, 900], ready: ".s-row" },
  { name: "loaded-narrow", size: [920, 680], ready: ".s-row" },
  { name: "loaded-tall", size: [760, 1100], ready: ".s-row" },
  { name: "empty", size: [1400, 900], env: { RIPTIDE_NO_TRACE: "1" }, ready: ".empty-state", noCanvas: true },
  {
    name: "menu-file",
    size: [1400, 900],
    ready: ".s-row",
    setup: async (win) => {
      await win.locator(".menubar .m").first().click();
      await win.waitForSelector(".menu-pop.show", { timeout: 5000 });
    },
  },
  {
    name: "ctx-signal",
    size: [1400, 900],
    ready: ".s-row",
    setup: async (win) => {
      await win.locator(".s-row").first().click({ button: "right" });
      await win.waitForSelector(".menu-pop.show", { timeout: 5000 });
    },
  },
  {
    // Coloris color picker (vendored .clr-* CSS + ColorPicker): click a row's pin.
    name: "color-picker",
    size: [1400, 900],
    ready: ".s-row",
    setup: async (win) => {
      await win.locator(".s-row .pin").first().click();
      await win.waitForSelector(".clr-picker.clr-open", { timeout: 5000 });
    },
  },
  {
    // Enum editor dialog (.modal + .enum-table): right-click rows until one
    // offers the radix "Enum" gear, click it to open the dialog.
    name: "enum-dialog",
    size: [1400, 900],
    ready: ".s-row",
    setup: async (win) => {
      // Right-click a row → hover the "Format" submenu → click the Enum gear.
      await win.locator(".s-row").first().click({ button: "right" });
      await win.waitForSelector(".menu-pop.show", { timeout: 5000 });
      await win.locator(".menu-item", { hasText: "Format" }).first().hover();
      await win.locator(".menu-gear").first().click({ timeout: 5000 });
      await win.waitForSelector(".modal", { timeout: 5000 });
      await win.waitForTimeout(150);
    },
  },
  {
    // Tooltip (.tip-pop portal): hover an element with data-tip.
    name: "tooltip",
    size: [1400, 900],
    ready: ".s-row",
    setup: async (win) => {
      await win.locator("[data-tip]").first().hover();
      await win.waitForSelector(".tip-pop.show", { timeout: 5000 });
    },
  },
];

async function launch(env) {
  const app = await electron.launch({
    args: [APP_ROOT, ...LAUNCH_ARGS],
    env: { ...process.env, RIPTIDE_VCD: MOCK_VCD, ...env },
    timeout: 60_000,
  });
  const win = await app.firstWindow();
  // The window stays visible but lives inside a throwaway nested compositor (see
  // run-headless.sh) so the real desktop / tiling WM never sees it — that's what
  // keeps screenshots deterministic. We capture via raw CDP Page.captureScreenshot
  // (not Playwright's page.screenshot) so we can neutralize the GPU canvas + freeze
  // animations with injected CSS rather than mask plumbing.
  const cdp = await win.context().newCDPSession(win);
  return { app, win, cdp };
}

// Force a deterministic viewport via CDP device-metrics override. The OS window
// size (esp. under Wayland) is not reliably honoured, so we override the rendered
// viewport + DPR directly — screenshots then match the requested size exactly,
// independent of the compositor. Then wait for fonts + a settle beat.
async function setSizeAndSettle(cdp, win, [w, h]) {
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width: w,
    height: h,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await win.evaluate(() => document.fonts.ready);
  await win.waitForTimeout(1200);
}

// Neutralize nondeterministic / out-of-scope paint before capture: hide the
// WebGPU canvas (GPU pixels are out of scope; the panel bg behind it is stable),
// freeze CSS animations/transitions, and blank the text caret.
const NEUTRALIZE_CSS = [
  "#gpu { visibility: hidden !important; }",
  "*, *::before, *::after { animation: none !important; transition: none !important; caret-color: transparent !important; }",
].join("\n");

async function capture(cdp, win, [w, h]) {
  await win.addStyleTag({ content: NEUTRALIZE_CSS });
  await win.waitForTimeout(150);
  const { data } = await cdp.send("Page.captureScreenshot", {
    format: "png",
    captureBeyondViewport: false,
    clip: { x: 0, y: 0, width: w, height: h, scale: 1 },
  });
  return Buffer.from(data, "base64");
}

before(() => {
  if (UPDATE) fs.mkdirSync(GOLDEN_DIR, { recursive: true });
});

for (const st of STATES) {
  test(`visual: ${st.name}`, async () => {
    const { app, win, cdp } = await launch(st.env);
    try {
      if (!st.noCanvas) await win.waitForSelector("canvas", { timeout: 30_000 });
      await win.waitForSelector(st.ready, { timeout: 30_000 });
      await setSizeAndSettle(cdp, win, st.size);
      if (st.setup) await st.setup(win);
      const shot = await capture(cdp, win, st.size);

      const golden = path.join(GOLDEN_DIR, `${st.name}.png`);
      if (UPDATE) {
        fs.writeFileSync(golden, shot);
        console.log(`  wrote golden ${st.name} (${shot.length} B)`);
        return;
      }
      assert.ok(fs.existsSync(golden), `no golden for ${st.name} — run with UPDATE_GOLDENS=1`);
      const r = diff(fs.readFileSync(golden), shot, CHANNEL);
      if (r.sizeMismatch) {
        const cur = path.join(GOLDEN_DIR, `${st.name}.actual.png`);
        fs.writeFileSync(cur, shot);
        assert.fail(`${st.name}: size changed golden=${r.width}x${r.height} (wrote ${cur})`);
      }
      const ratio = r.diffPixels / r.total;
      if (ratio > RATIO) {
        const cur = path.join(GOLDEN_DIR, `${st.name}.actual.png`);
        fs.writeFileSync(cur, shot);
        assert.fail(
          `${st.name}: ${r.diffPixels}/${r.total} px differ (${(ratio * 100).toFixed(3)}% > ${(RATIO * 100).toFixed(3)}%); wrote ${cur}`,
        );
      }
    } finally {
      await app.close();
    }
  });
}
