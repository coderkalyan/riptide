// Headless deterministic GPU render harness.
//
// Drives the REAL renderer GPU modules (gpu/*.ts) under Deno's native WebGPU,
// renders one representative frame to an offscreen rgba8unorm texture, reads it
// back, and writes a PNG + raw .bin. Used to prove that GPU refactors which are
// meant to be visually no-ops produce pixel-identical output.
//
// Build (esbuild bundles the .wgsl text imports), then run with Deno:
//   node scripts/canvas-test/build.mjs
//   deno run --allow-all scripts/canvas-test/harness.bundle.mjs [--update|--equiv]
//
// Modes:
//   (default)  render the production path, compare to the golden .bin, exit 1 on diff.
//   --update   render the production path, (over)write the golden .bin + .png.
//   --equiv    render pills two ways in this same build — production renderFrame
//              (one shared rect/text buffer, per-pill firstInstance draws) vs a
//              per-pill-batch reference (the pre-refactor behavior) — and assert
//              the full frames are pixel-identical.
//
// See TESTING.md § Canvas (GPU) testing.

import { createDigitalRenderer, SignalPipeline } from "../../src/renderer/gpu/digital";
import { createLineRenderer, LineSpec } from "../../src/renderer/gpu/lines";
import { createRectRenderer, RectSpec, RectBatch } from "../../src/renderer/gpu/rect";
import { createTextRenderer, packRgba, AtlasBuild, TextBatch } from "../../src/renderer/gpu/text";
import { createLabelRenderer } from "../../src/renderer/gpu/labels";
import { createColorBuffer, writeRowColors } from "../../src/renderer/gpu/colors";
import { renderFrame, PillRange } from "../../src/renderer/gpu/frame";
import { Viewport } from "../../src/renderer/gpu/data";

// ----- scene constants (mirror the app where it matters; otherwise arbitrary
// but fixed so the golden is stable) -----
const W = 768; // 4*W is a multiple of 256 → no readback row padding
const H = 128;
const ROW_H = 28;
const WAVE_Y = 30;
const TICKS_PER_PX = 0.125; // 8 px / tick; window = 0..96 ticks
const LINE_THICKNESS_CSS = 2.5;

const C = {
  GRID: packRgba(0x86, 0x8c, 0x96, 0x70),
  HOT: packRgba(0xf0, 0x6b, 0x5b, 0xff),
  MARKER_A: packRgba(0x4f, 0xd2, 0xbd, 0xff),
  MARKER_B: packRgba(0xc8, 0x9b, 0xf0, 0xff),
  ON_ACCENT: packRgba(0x0f, 0x1a, 0x09, 0xff),
  TEXT_SECONDARY: packRgba(0xc4, 0xc3, 0xbb, 0xff),
  PANEL_2: packRgba(0x22, 0x25, 0x2a, 0xff),
};

const xForTick = (t: number) => (t - 0) / TICKS_PER_PX;

// ----- procedural glyph atlas (Deno has no Canvas 2D). Deterministic; lays out
// ATLAS_COUNT equal-width cells. Content is a per-code pattern so distinct glyphs
// differ — enough to exercise sampling + catch text regressions. -----
const ATLAS_FIRST = 0x20;
const ATLAS_COUNT = 96; // 0x20..0x7e (95) + middle-dot slot

function proceduralAtlas(displayPx: number, dpr: number): AtlasBuild {
  const scale = 2 * dpr;
  const fontPx = displayPx * scale;
  const advance = Math.round(0.6 * fontPx);
  const capAscent = Math.round(0.72 * fontPx);
  const descent = Math.round(0.2 * fontPx);
  const padTop = 2, padBottom = 2;
  const cellW = advance + 2;
  const cellH = capAscent + descent + padTop + padBottom;
  const baselineY = padTop + capAscent;
  const midlineY = padTop + capAscent * 0.5;
  const width = cellW * ATLAS_COUNT;
  const height = cellH;
  const rgba = new Uint8Array(width * height * 4);
  for (let cell = 0; cell < ATLAS_COUNT; cell++) {
    const code = cell <= ATLAS_LAST_IDX ? ATLAS_FIRST + cell : 0x7f;
    for (let y = 0; y < cellH; y++) {
      for (let lx = 0; lx < cellW; lx++) {
        const inGlyph = lx >= 2 && lx < cellW - 2 && y >= padTop && y < padTop + capAscent;
        const on = inGlyph && (((lx + y + code * 7) >> 1) & 1) === 0;
        const px = ((y * width) + cell * cellW + lx) * 4;
        rgba[px + 0] = 255; rgba[px + 1] = 255; rgba[px + 2] = 255;
        rgba[px + 3] = on ? 255 : 0;
      }
    }
  }
  return {
    width, height, rgba,
    cellWCSS: cellW / scale, cellHCSS: cellH / scale,
    ascentCSS: baselineY / scale, midlineCSS: midlineY / scale,
  };
}
const ATLAS_LAST_IDX = 0x7e - 0x20; // last ASCII cell index

// ----- synthetic waveform: rows 0,1 single-bit (clock-ish), row 2 multi-bit bus.
// Layouts per CLAUDE.md / digital.wgsl / segments.zig. The fixture deliberately
// covers BOTH sides of every flat-flag fragment branch (4.1): shaded vs unshaded
// rows, x/z samples (→ crosshatch), and a rising-edge caret pair. -----
const F_SHADE = 1 << 16;
const F_RIGHT_EDGE = 1 << 17;
const F_RISING_EDGE = 1 << 18;
const F_RISING_EDGE_LEFT = 1 << 21;

function buildDigital() {
  const single: number[] = [];
  const multi: number[] = [];
  // row 0: clock, line only (no F_SHADE) — exercises the unshaded branch + a
  // rising-edge caret pair on segments 2/3 (caret branch taken).
  for (let i = 0; i < 8; i++) {
    let f = 0 | F_RIGHT_EDGE;
    if (i === 2) f |= F_RISING_EDGE;
    if (i === 3) f |= F_RISING_EDGE_LEFT;
    single.push(i * 12, (i + 1) * 12, f);
  }
  // row 1: shaded — so the x/z crosshatch fill (segments 4=x, 5=z) is visible.
  for (let i = 0; i < 8; i++) single.push(i * 12, (i + 1) * 12, 1 | F_RIGHT_EDGE | F_SHADE);
  // row 2: 4 bus windows, 24 wide, shaded; segment 1 is z → crosshatch pill.
  const busVals = [0x00, 0xa5, 0x10, 0x3c];
  for (let i = 0; i < 4; i++) multi.push(i * 24, (i + 1) * 24, 2 | F_SHADE);

  // rowInfo: 5 u32 each (x0_offset, x1_offset, bytes_per_sample, segment_start, flags)
  const rowInfo = new Uint32Array([
    0, 0, 1, 0, 0,   // row0: 8 samples at pool byte 0
    8, 8, 1, 8, 0,   // row1: 8 samples at pool byte 8, single-pipeline instance 8
    16, 16, 1, 0, 0, // row2: 4 samples at pool byte 16, multi-pipeline instance 0
  ]);
  // sample pools (LSB / MSB), one byte per sample (bps=1). (m,l): (0,0)=0 (0,1)=1
  // (1,0)=x (1,1)=z. MSB nonzero → vertex sets F_CROSSHATCH.
  const x0 = new Uint8Array(20);
  const x1 = new Uint8Array(20);
  for (let i = 0; i < 8; i++) x0[i] = i % 2;            // row0: 0,1,0,1,...
  for (let i = 0; i < 8; i++) x0[8 + i] = (i + 1) % 2;  // row1: 1,0,1,0,...
  x1[8 + 4] = 1; x0[8 + 4] = 0;                         // row1 seg4 = x
  x1[8 + 5] = 1; x0[8 + 5] = 1;                         // row1 seg5 = z
  for (let i = 0; i < 4; i++) x0[16 + i] = busVals[i];  // row2 bus values
  x1[16 + 1] = 1;                                       // row2 seg1 = z → crosshatch
  return {
    single: new Uint32Array(single),
    multi: new Uint32Array(multi),
    rowInfo,
    x0: x0.buffer as ArrayBuffer,
    x1: x1.buffer as ArrayBuffer,
  };
}

// ----- pills (the code under test). addFlag math ported verbatim from
// WaveCanvas.tsx. Emits geometry-only descriptors consumed by both the shared
// and per-pill builders. -----
interface PillDesc { x: number; y: number; w: number; h: number; color: number; sqBL: boolean; sqBR: boolean; text: string; }
const PAD_X = 5;
const PILL_H = 14;

function computePills(cellWsm: number): PillDesc[] {
  const out: PillDesc[] = [];
  const add = (lineX: number, text: string, color: number) => {
    const pillW = text.length * cellWsm + PAD_X * 2;
    const flipStart = W - pillW;
    const t = Math.max(0, Math.min(1, (lineX - flipStart) / pillW));
    const anchor = lineX + t * LINE_THICKNESS_CSS;
    const pillX = Math.max(0, Math.min(W - pillW, anchor - t * pillW));
    const lineOnRight = t >= 0.5;
    out.push({ x: pillX, y: 0, w: pillW, h: PILL_H, color, sqBL: !lineOnRight, sqBR: lineOnRight, text });
  };
  add(xForTick(18), "M1 · 18 ns", C.MARKER_A);
  add(xForTick(66), "M2 · 66 ns", C.MARKER_B);
  add(xForTick(40), "40 ns", C.HOT); // cursor
  return out;
}

function pillRect(d: PillDesc): RectSpec {
  return { x: d.x, y: d.y, w: d.w, h: d.h, color: d.color, rounded: true, squareBottomLeft: d.sqBL, squareBottomRight: d.sqBR };
}

function writePillText(batch: TextBatch, start: number, d: PillDesc, cellWsm: number, midlineSm: number): number {
  let gi = start;
  const x = Math.round(d.x + PAD_X);
  const y = Math.round(d.y + PILL_H * 0.5 - midlineSm);
  for (let k = 0; k < d.text.length; k++) {
    const code = d.text.charCodeAt(k);
    if ((code < 0x20 || code > 0x7e) && code !== 0x00b7) continue;
    batch.writeGlyph(gi++, x + k * cellWsm, y, code, C.ON_ACCENT, true);
  }
  return gi;
}

async function main() {
  const mode = Deno.args.includes("--update") ? "update" : Deno.args.includes("--equiv") ? "equiv" : "check";

  // headless GPU init
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: "high-performance" });
  if (!adapter) { console.error("no WebGPU adapter"); Deno.exit(2); }
  const device = await adapter.requestDevice({
    requiredLimits: {
      maxStorageBufferBindingSize: adapter.limits.maxStorageBufferBindingSize,
      maxBufferSize: adapter.limits.maxBufferSize,
    },
  });
  const format: GPUTextureFormat = "rgba8unorm";
  const target = device.createTexture({
    size: [W, H], format,
    usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
  });
  // frame.ts only uses ctx.getCurrentTexture(); fake it to our offscreen target.
  const ctx = { getCurrentTexture: () => target } as unknown as GPUCanvasContext;
  const gpu = { device, ctx, format };

  // renderers
  const renderer = createDigitalRenderer(gpu);
  const lineR = await createLineRenderer(gpu, renderer.uniformBuf);
  const rectR = await createRectRenderer(gpu, renderer.uniformBuf);
  const textR = await createTextRenderer(gpu, renderer.uniformBuf, {
    dpr: 1, atlasFactory: (px, dpr) => proceduralAtlas(px, dpr),
  });
  const labelR = await createLabelRenderer(gpu, renderer.uniformBuf, textR.atlasLgView, textR.sampler, textR.cellLg);
  const cellWsm = textR.cellSm.widthPx;
  const midlineSm = textR.cellSm.midlinePx;

  // colors
  const colorBuf = createColorBuffer(device);
  writeRowColors(device, colorBuf, [
    { row: 0, color: "#4fd2bd" }, { row: 1, color: "#f0b35b" }, { row: 2, color: "#6f9bd8" },
  ]);

  // digital pipelines
  const dig = buildDigital();
  const scene = renderer.createSceneBuffers(dig.rowInfo.buffer as ArrayBuffer, dig.x0, dig.x1);
  const singlePipe: SignalPipeline = await renderer.buildPipelineFromPacked("single", dig.single, dig.single.length / 3, colorBuf, scene);
  const multiPipe: SignalPipeline = await renderer.buildPipelineFromPacked("multi", dig.multi, dig.multi.length / 3, colorBuf, scene);
  renderer.setDimFlags(scene, () => false);

  // static layers (identical across both pill paths)
  const linesBg = lineR.createBatch();
  const linesFg = lineR.createBatch();
  const rectsBg = rectR.createBatch();
  const textBody = textR.createBatch();
  const labels = labelR.createBatch(); // left empty (bindGroup null) → skipped

  const grid: LineSpec[] = [];
  for (let t = 0; t <= 96; t += 12) grid.push({ x: xForTick(t), color: C.GRID, dashed: true });
  linesBg.setLines(grid);
  linesFg.setLines([
    { x: xForTick(40), color: C.HOT },
    { x: xForTick(18), color: C.MARKER_A },
    { x: xForTick(66), color: C.MARKER_B },
  ]);

  const bgRects: RectSpec[] = [
    { x: 0, y: WAVE_Y + 2 * ROW_H, w: W, h: ROW_H, color: C.PANEL_2 },        // tint behind row 2
    { x: xForTick(84), y: 0, w: W - xForTick(84), h: H, color: C.GRID, crosshatch: true }, // dead-zone hatch
  ];
  rectsBg.setRects(bgRects);

  const ruler: { x: number; t: string }[] = [];
  for (let t = 0; t <= 96; t += 24) ruler.push({ x: xForTick(t) + 2, t: `${t}` });
  let gi = 0;
  for (const r of ruler) {
    for (let k = 0; k < r.t.length; k++) {
      textBody.writeGlyph(gi++, r.x + k * cellWsm, 14, r.t.charCodeAt(k), C.TEXT_SECONDARY, true);
    }
  }
  textBody.setGlyphs(gi);

  const vp: Viewport = {
    ticks_per_pixel: TICKS_PER_PX, start_ticks: 0, width: W, height: H,
    row_height: ROW_H, dpr: 1, selected_row: -1, wave_y_offset: WAVE_Y,
  };
  const pipelines = [multiPipe, singlePipe];
  const descs = computePills(cellWsm);

  // ----- production pill path: one shared rect buffer + one shared text buffer,
  // per-pill firstInstance draws via renderFrame -----
  const pillRects = rectR.createBatch();
  const pillText = textR.createBatch();
  const pillRanges: PillRange[] = [];
  function fillSharedPills() {
    const rs: RectSpec[] = [];
    let g = 0;
    descs.forEach((d, i) => {
      rs.push(pillRect(d));
      const textStart = g;
      g = writePillText(pillText, g, d, cellWsm, midlineSm);
      pillRanges[i] = { rectStart: i, rectCount: 1, textStart, textCount: g - textStart };
    });
    pillRects.setRects(rs, rs.length);
    pillText.setGlyphs(g);
  }

  function renderProduction(): void {
    fillSharedPills();
    renderFrame(gpu, renderer, pipelines, {
      linesBg, rectsBg, labels, linesFg, textBody,
      pillRects, pillText, pillRanges, pillRangeCount: descs.length,
    }, vp);
  }

  // ----- reference pill path: pre-refactor behavior — one rect batch + one text
  // batch per pill, each drawn fully (firstInstance 0). Same draw order as the
  // production frame for every non-pill layer. -----
  const refPills = descs.map((d) => {
    const rb = rectR.createBatch();
    const tb = textR.createBatch();
    rb.setRects([pillRect(d)], 1);
    const g = writePillText(tb, 0, d, cellWsm, midlineSm);
    tb.setGlyphs(g);
    return { rb, tb };
  });
  function renderReference(): void {
    renderer.writeViewport(vp);
    const enc = device.createCommandEncoder();
    const pass = enc.beginRenderPass({
      colorAttachments: [{
        view: target.createView(), loadOp: "clear",
        clearValue: { r: 0.106, g: 0.114, b: 0.129, a: 1 }, storeOp: "store",
      }],
    });
    const drawLines = (b: typeof linesBg) => { if (b.lineCount) { pass.setPipeline(b.pipeline); pass.setBindGroup(0, b.bindGroup); pass.draw(4, b.lineCount); } };
    const drawRects = (b: RectBatch) => { if (b.rectCount) { pass.setPipeline(b.pipeline); pass.setBindGroup(0, b.bindGroup); pass.draw(4, b.rectCount); } };
    const drawText = (b: TextBatch) => { if (b.glyphCount) { pass.setPipeline(b.pipeline); pass.setBindGroup(0, b.bindGroup); pass.draw(4, b.glyphCount); } };
    drawLines(linesBg);
    drawRects(rectsBg);
    for (const p of pipelines) { pass.setPipeline(p.pipeline); pass.setBindGroup(0, p.bindGroup); pass.draw(4, p.segmentCount); }
    // labels empty → skipped
    drawText(textBody);
    drawLines(linesFg);
    for (const { rb, tb } of refPills) { drawRects(rb); drawText(tb); }
    pass.end();
    device.queue.submit([enc.finish()]);
  }

  if (mode === "equiv") {
    renderProduction();
    const a = await readback(device, target, W, H);
    renderReference();
    const b = await readback(device, target, W, H);
    const diff = countDiff(a, b);
    if (diff === 0) {
      console.log("EQUIV PASS — production (shared buffer + firstInstance) and per-pill reference are pixel-identical.");
      Deno.exit(0);
    }
    console.error(`EQUIV FAIL — ${diff} pixels differ.`);
    await writePng("/tmp/canvas-equiv-production.png", W, H, a);
    await writePng("/tmp/canvas-equiv-reference.png", W, H, b);
    console.error("wrote /tmp/canvas-equiv-{production,reference}.png");
    Deno.exit(1);
  }

  renderProduction();
  const img = await readback(device, target, W, H);
  const dir = new URL("./golden/", import.meta.url);
  const binPath = new URL("scene.bin", dir);
  const pngPath = new URL("scene.png", dir);

  if (mode === "update") {
    await Deno.mkdir(dir, { recursive: true });
    await Deno.writeFile(binPath, img);
    await writePng(pngPath, W, H, img);
    console.log(`golden updated: ${binPath.pathname} (+ scene.png)`);
    Deno.exit(0);
  }

  // check
  let golden: Uint8Array;
  try {
    golden = await Deno.readFile(binPath);
  } catch {
    console.error(`no golden at ${binPath.pathname} — run with --update first.`);
    Deno.exit(2);
  }
  const diff = countDiff(img, golden!);
  if (diff === 0) {
    console.log("CHECK PASS — render matches golden exactly.");
    Deno.exit(0);
  }
  console.error(`CHECK FAIL — ${diff} pixels differ from golden.`);
  await writePng("/tmp/canvas-check-actual.png", W, H, img);
  console.error("wrote /tmp/canvas-check-actual.png");
  Deno.exit(1);
}

function countDiff(a: Uint8Array, b: Uint8Array): number {
  if (a.length !== b.length) return Math.max(a.length, b.length);
  let n = 0;
  for (let i = 0; i < a.length; i += 4) {
    if (a[i] !== b[i] || a[i + 1] !== b[i + 1] || a[i + 2] !== b[i + 2] || a[i + 3] !== b[i + 3]) n++;
  }
  return n;
}

async function readback(device: GPUDevice, tex: GPUTexture, w: number, h: number): Promise<Uint8Array> {
  const bytesPerRow = Math.ceil((w * 4) / 256) * 256;
  const buf = device.createBuffer({ size: bytesPerRow * h, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
  const enc = device.createCommandEncoder();
  enc.copyTextureToBuffer({ texture: tex }, { buffer: buf, bytesPerRow, rowsPerImage: h }, [w, h, 1]);
  device.queue.submit([enc.finish()]);
  await buf.mapAsync(GPUMapMode.READ);
  const padded = new Uint8Array(buf.getMappedRange()).slice();
  buf.unmap();
  buf.destroy();
  const out = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) out.set(padded.subarray(y * bytesPerRow, y * bytesPerRow + w * 4), y * w * 4);
  return out;
}

// ----- minimal PNG (8-bit RGBA, filter 0, single zlib IDAT via CompressionStream) -----
async function writePng(path: string | URL, w: number, h: number, rgba: Uint8Array): Promise<void> {
  const raw = new Uint8Array(h * (1 + w * 4));
  for (let y = 0; y < h; y++) {
    raw[y * (1 + w * 4)] = 0; // filter: none
    raw.set(rgba.subarray(y * w * 4, (y + 1) * w * 4), y * (1 + w * 4) + 1);
  }
  const idat = await zlibDeflate(raw);
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, w); dv.setUint32(4, h);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const chunks = [chunk("IHDR", ihdr), chunk("IDAT", idat), chunk("IEND", new Uint8Array(0))];
  const sig = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  let total = sig.length;
  for (const c of chunks) total += c.length;
  const out = new Uint8Array(total);
  out.set(sig, 0);
  let off = sig.length;
  for (const c of chunks) { out.set(c, off); off += c.length; }
  await Deno.writeFile(path, out);
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  dv.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

async function zlibDeflate(data: Uint8Array): Promise<Uint8Array> {
  const cs = new CompressionStream("deflate"); // zlib-wrapped (RFC1950), what PNG IDAT wants
  const writer = cs.writable.getWriter();
  writer.write(data); writer.close();
  const parts: Uint8Array[] = [];
  const reader = cs.readable.getReader();
  for (;;) { const { value, done } = await reader.read(); if (done) break; parts.push(value); }
  let len = 0; for (const p of parts) len += p.length;
  const out = new Uint8Array(len); let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

main();
