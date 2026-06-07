"use strict";
// Capture a marketing screenshot of Riptide with the bundled mock VCD loaded,
// WebGPU waveforms and all, for keeping the website up to date.
//
//   pnpm build                              # once, so dist/ is current
//   node scripts/screenshot.cjs [out.png]   # default: ./riptide.png
//   SIZE=1600x1000 DPR=2 node scripts/screenshot.cjs web/static/riptide.png
//
// A window briefly opens on your display while it renders, then closes.
// Env: SIZE ("WxH" CSS px, default 1400x900), DPR (default 2 → retina),
//      SETTLE_MS (let the GPU draw frames before capture, default 2500).

const { _electron: electron } = require("playwright-core");
const path = require("node:path");
const fs = require("node:fs");

const APP = path.join(__dirname, "..");
const MOCK = path.join(APP, "native", "src", "mock.vcd");
const OUT = path.resolve(process.argv[2] || process.env.OUT || "riptide.png");
const [W, H] = (process.env.SIZE || "1400x900").split("x").map(Number);
const DPR = Number(process.env.DPR || 2);
const SETTLE_MS = Number(process.env.SETTLE_MS || 2500);

(async () => {
  const app = await electron.launch({
    args: [APP, "--enable-unsafe-webgpu", "--enable-features=Vulkan"],
    env: { ...process.env, RIPTIDE_VCD: MOCK },
    timeout: 60_000,
  });
  const win = await app.firstWindow();
  const cdp = await win.context().newCDPSession(win);
  // Fixed render size + DPR, independent of the OS window size.
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: W, height: H, deviceScaleFactor: DPR, mobile: false });
  await win.waitForSelector("canvas", { timeout: 30_000 });
  await win.waitForSelector(".s-row", { timeout: 30_000 });
  await win.evaluate(() => document.fonts.ready);
  await win.waitForTimeout(SETTLE_MS); // let the rAF loop draw real GPU frames

  const buf = await win.screenshot({ clip: { x: 0, y: 0, width: W, height: H } });
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, buf);
  console.log(`wrote ${OUT} (${W}x${H} @${DPR}x = ${W * DPR}x${H * DPR}px)`);
  await app.close();
})().catch((e) => { console.error(e); process.exit(1); });
