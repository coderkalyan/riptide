#!/usr/bin/env node
// Render the WebGPU canvas mock as a static SVG.
// Replicates the geometry / colors produced by src/renderer/gpu/* + hier/mock.ts
// at the auto-fit viewport (start_ticks=0, ticks_per_pixel = MOCK_END_TICKS/W).

import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

// ----- viewport ----------------------------------------------------------
// Sized for a 2880x1920 display at DPR=2 → CSS viewport 1440x960.
// Canvas occupies the wave column inside the body grid, with default panel
// widths from App.tsx: tree=236, active=296 → 1440-236-296 = 908 CSS px wide.
// Height = 100vh - titlebar(36) - menubar(34) - col-head(34) - col-sub(34) - status(24) = 798.
const DPR = 2;
const CANVAS_W = 908;      // CSS px — DOM-derived
const CANVAS_H = 798;      // CSS px — DOM-derived
const ROW_H = 28;          // CSS var(--row-h)
const RULER_H = ROW_H;     // App.tsx: rulerHeightCSS = rowHeightCSS
const ACTIVE_ROWS = 14;

const MOCK_CLOCK_TICK_NS = 5;
const MOCK_END_TICKS = 90;
const ticksPerPixel = MOCK_END_TICKS / CANVAS_W;
const startTicks = 0;
const xForTick = (t) => (t - startTicks) / ticksPerPixel;

const INITIAL_CURSOR_TICKS = 32.4;
const MARKER_TICKS = 19.6;
const SELECTED_ROW = 2;

// ----- palette (CSS vars from index.html + App.tsx packRgba calls) -------
const BG = [0x1B, 0x1D, 0x21];          // canvas clear color
const PANEL_2 = "#22252A";
const BORDER = "#2F333A";
const TEXT_2 = "#C4C3BB";
const TEXT_WHITE = "#FFFFFF";
const ON_ACCENT = "#0F1A09";
const NOTCH_COLOR = "#868C96";
const HOT = "#F06B5B";
const MARKER = "#4FD2BD";
const GRID_RGB = [0x86, 0x8C, 0x96];
const GRID_A = 0x70 / 255;
const DEAD_RGB = [0x78, 0x7C, 0x86];
const DEAD_A = 0x70 / 255;

// digital.wgsl shader-side constants
const X_RGB = [245, 114, 114]; // 0.9608, 0.4471, 0.4471
const Z_RGB = [255, 220, 0];   // 1.0, 0.863, 0.0
const MUTE_RGB = [120, 120, 120];
const MUTE_A = 0.6;
const X_MULTI_A = 0.7;
const Z_MULTI_A = 0.7;

// per-row primary colors (mock.ts)
const ROW_COLORS = [
  "#72F5DF", "#F06B5B", "#B48CFF", "#B48CFF",
  "#F4A698", "#F4A698", "#F4A698", "#57C88A",
  "#57C88A", "#E6B14E", "#E6B14E", "#4FD2BD",
  "#4FD2BD", "#4FD2BD",
];
const ROW_BITS = [1, 1, 2, 8, 1, 8, 16, 1, 32, 4, 1, 8, 1, 1];
const ROW_RADIX = ["bin", "bin", "dec", "dec", "bin", "hex", "hex", "bin", "hex", "dec", "bin", "hex", "bin", "bin"];
const STATE_LABELS = { 0: "IDLE", 1: "BUSY", 2: "WAIT" };
const ROW_ENUM = { 2: STATE_LABELS };

// ----- per-cycle mock values (mock.ts) -----------------------------------
const CYCLE_DURS = [1, 2, 2, 2, 2, 2, 2, 2, 2, 1];
const V_STATE = ["x", "x", 0, 0, 1, 2, 2, 1, 0, 0];
const V_CYCLE = ["x", "x", 0, 1, 2, 3, 4, 5, 6, 7];
const V_IN_VALID = [0, 0, 0, 1, 1, 0, 1, 1, 0, 0];
const V_IN_DATA = ["x", "x", "x", 0xA3, 0xA3, "x", 0xB7, 0xB7, "x", "x"];
const V_IN_ADDR = ["x", "x", "x", 0x1000, 0x1004, "x", 0x1008, 0x100C, "x", "x"];
const V_OUT_VALID = [0, 0, 0, 0, 0, 1, 1, 1, 1, 0];
const V_OUT_DATA = ["x", "x", "x", "x", "x", 0xDEADBEEF, 0xDEADBEEF, 0xCAFEB0BA, 0xCAFEB0BA, "x"];
const V_FIFO_LEVEL = ["x", "x", 0, 1, 2, 2, 2, 1, 0, 0];
const V_FIFO_EMPTY = ["x", "x", 1, 0, 0, 0, 0, 0, 1, 1];
const V_DBUS = ["x", "x", "z", 0x55, 0x55, "z", 0xF0, 0xF0, "z", "z"];
const V_BUSY = [0, 0, 0, 1, 1, 1, 1, 1, 1, 0];
const V_DONE = [0, 0, 0, 0, 0, 0, 0, 0, 1, 0];
const MUTE_IN = V_IN_VALID.map((v) => v !== 1);
const MUTE_OUT = V_OUT_VALID.map((v) => v !== 1);

// ----- segment builders (port of data.ts) --------------------------------
const maskForWidth = (w) => (w === 32 ? 0xFFFFFFFF : ((1 << w) - 1) >>> 0);
function valueBits(v, w) {
  const m = maskForWidth(w);
  if (v === "x") return { lsb: 0, msb: m };
  if (v === "z") return { lsb: m, msb: m };
  return { lsb: (v & m) >>> 0, msb: 0 };
}
function sameValue(a, b, w) {
  const A = valueBits(a, w), B = valueBits(b, w);
  return A.lsb === B.lsb && A.msb === B.msb;
}

function buildDataSignal(row, bw, values, muted) {
  const segs = [];
  const muteAt = (i) => !!(muted && muted[i]);
  let i = 0, tick = 0;
  while (i < values.length) {
    const start = tick;
    let j = i;
    while (
      j + 1 < values.length &&
      sameValue(values[j], values[j + 1], bw) &&
      muteAt(j + 1) === muteAt(i)
    ) j++;
    let end = start;
    for (let k = i; k <= j; k++) end += CYCLE_DURS[k] * MOCK_CLOCK_TICK_NS;
    const bits = valueBits(values[i], bw);
    const hasNext = j + 1 < values.length;
    let drawRightEdge = hasNext;
    if (drawRightEdge && bw === 1) {
      const next = valueBits(values[j + 1], bw);
      if (bits.msb !== 0 || next.msb !== 0) drawRightEdge = false;
    }
    segs.push({
      row, bw, tStart: start, tEnd: end,
      lsb: bits.lsb, msb: bits.msb,
      shade: true, edge: drawRightEdge, mute: muteAt(i),
    });
    tick = end; i = j + 1;
  }
  return segs;
}

function buildClockSegments(row) {
  const half = MOCK_CLOCK_TICK_NS;
  const count = MOCK_END_TICKS / half;
  const segs = [];
  for (let i = 0; i < count; i++) {
    const val = i % 2;
    const start = i * half;
    const hasNext = i + 1 < count;
    segs.push({
      row, bw: 1, tStart: start, tEnd: start + half,
      lsb: val, msb: 0,
      shade: false, edge: hasNext, mute: false,
    });
  }
  return segs;
}

function buildRawSegments(row, raw) {
  return raw.map((r, i) => {
    const v = valueBits(r.value, 1);
    return {
      row, bw: 1, tStart: r.tStart, tEnd: r.tEnd,
      lsb: v.lsb, msb: v.msb,
      shade: true, edge: i + 1 < raw.length, mute: !!r.muted,
    };
  });
}

const SEGMENTS = [
  ...buildClockSegments(0),
  ...buildRawSegments(1, [{ tStart: 0, tEnd: 10, value: 1 }, { tStart: 10, tEnd: MOCK_END_TICKS, value: 0 }]),
  ...buildDataSignal(2, 2, V_STATE),
  ...buildDataSignal(3, 8, V_CYCLE),
  ...buildDataSignal(4, 1, V_IN_VALID),
  ...buildDataSignal(5, 8, V_IN_DATA, MUTE_IN),
  ...buildDataSignal(6, 16, V_IN_ADDR, MUTE_IN),
  ...buildDataSignal(7, 1, V_OUT_VALID),
  ...buildDataSignal(8, 32, V_OUT_DATA, MUTE_OUT),
  ...buildDataSignal(9, 4, V_FIFO_LEVEL),
  ...buildDataSignal(10, 1, V_FIFO_EMPTY),
  ...buildDataSignal(11, 8, V_DBUS),
  ...buildDataSignal(12, 1, V_BUSY),
  ...buildDataSignal(13, 1, V_DONE),
];

// ----- formatting (App.tsx) ----------------------------------------------
function formatSegmentValue(seg, bw, radix, enumLabels) {
  const hasX = (seg.msb & ~seg.lsb) >>> 0;
  const hasZ = (seg.msb & seg.lsb) >>> 0;
  if (hasX || hasZ) {
    const chars = [];
    for (let bit = bw - 1; bit >= 0; bit--) {
      const l = (seg.lsb >>> bit) & 1;
      const m = (seg.msb >>> bit) & 1;
      if (m === 0 && l === 0) chars.push("0");
      else if (m === 0 && l === 1) chars.push("1");
      else if (m === 1 && l === 0) chars.push("x");
      else chars.push("z");
    }
    return bw === 1 ? chars[0] : `0b${chars.join("")}`;
  }
  const val = seg.lsb >>> 0;
  if (enumLabels && enumLabels[val] != null) return enumLabels[val];
  if (bw === 1) return String(val);
  if (radix === "hex") return `0x${val.toString(16).toUpperCase()}`;
  if (radix === "dec") return String(val);
  return `0b${val.toString(2).padStart(bw, "0")}`;
}

function rulerSpacing(visible) {
  const target = visible / 8;
  const exp = Math.floor(Math.log10(target));
  const base = Math.pow(10, exp);
  const m = target / base;
  if (m < 2) return base;
  if (m < 5) return 2 * base;
  return 5 * base;
}
function dynamicRulerTicks(start, visible) {
  const sp = rulerSpacing(visible);
  const first = Math.ceil(start / sp) * sp;
  const ticks = [];
  const end = start + visible + sp * 1e-6;
  for (let t = first; t <= end; t += sp) ticks.push(t);
  return { ticks, sp };
}
function formatRulerLabel(t, sp) {
  const dec = sp >= 1 ? 0 : Math.max(0, -Math.floor(Math.log10(sp)));
  return `${t.toFixed(dec)} ns`;
}

const visibleTicks = CANVAS_W * ticksPerPixel;
const { ticks: rulerTicks, sp: rulerStep } = dynamicRulerTicks(startTicks, visibleTicks);
const CLOCK_EDGE_TICKS = [];
for (let t = MOCK_CLOCK_TICK_NS; t < MOCK_END_TICKS; t += 2 * MOCK_CLOCK_TICK_NS) {
  CLOCK_EDGE_TICKS.push(t);
}

// ----- color helpers -----------------------------------------------------
function hexToRgb(hex) {
  const h = hex.replace("#", "");
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}
function blend(rgb, alpha) {
  // mix(bg, color, alpha) — replicates `mix(bg, color.rgb, color.a)` shader output
  const [r, g, b] = rgb;
  return [
    Math.round(BG[0] + (r - BG[0]) * alpha),
    Math.round(BG[1] + (g - BG[1]) * alpha),
    Math.round(BG[2] + (b - BG[2]) * alpha),
  ];
}
const rgb = (c) => `rgb(${c[0]},${c[1]},${c[2]})`;

// ----- SVG emission ------------------------------------------------------
const out = [];
const W = CANVAS_W, H = CANVAS_H;
out.push(
  `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" ` +
  `font-family="'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, Consolas, monospace" ` +
  `font-size="12" shape-rendering="crispEdges">`
);

// --- patterns: crosshatch fills (45° diagonal, period 4 px, ~33% on)
// All patterns include an opaque BG-colored rect so they fully occlude
// underlying grid lines, matching the shader's opaque output.
function emitHatchPattern(id, stripeRgb, stripeA, bgRect = true) {
  const stripe = blend(stripeRgb, stripeA); // pre-blend against canvas bg
  const fill = bgRect ? `<rect width="4" height="4" fill="${rgb(BG)}"/>` : "";
  // 1.33 px wide stripe ≈ 33% of 4 px period
  return `<pattern id="${id}" width="4" height="4" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">${fill}<rect width="1.33" height="4" fill="${rgb(stripe)}"/></pattern>`;
}
function emitHatchPatternRaw(id, stripeColor, stripeA, bgFill, stripeWidth = 1.33) {
  // Used for the dead-zone pattern (over canvas bg, no opaque bg needed —
  // signals never overlap dead zone). bgFill is "none" or BG.
  const bgRect = bgFill !== "none" ? `<rect width="4" height="4" fill="${bgFill}"/>` : "";
  return `<pattern id="${id}" width="4" height="4" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">${bgRect}<rect width="${stripeWidth}" height="4" fill="${stripeColor}" fill-opacity="${stripeA}"/></pattern>`;
}

out.push("<defs>");
// digital.wgsl crosshatch (single-bit x/z: alpha 1.0; multi-bit x/z: alpha 0.7)
out.push(emitHatchPattern("hatch-x-single", X_RGB, 1.0));
out.push(emitHatchPattern("hatch-z-single", Z_RGB, 1.0));
out.push(emitHatchPattern("hatch-x-multi", X_RGB, X_MULTI_A));
out.push(emitHatchPattern("hatch-z-multi", Z_RGB, Z_MULTI_A));
out.push(emitHatchPattern("hatch-mute", MUTE_RGB, MUTE_A));
// rect.wgsl dead-zone crosshatch (over canvas bg only, thinner stripe)
out.push(emitHatchPatternRaw("hatch-dead", rgb(DEAD_RGB), DEAD_A, "none", 0.8));
out.push("</defs>");

// 0. canvas clear
out.push(`<rect width="${W}" height="${H}" fill="${rgb(BG)}"/>`);

// 1. grid lines (linesBg) — drawn before signals; signals occlude in pill area
const GRID_THICK = 1.25 * DPR;
const GRID_TOP_Y = 8;
for (const t of CLOCK_EDGE_TICKS) {
  // App.tsx: gridInset = GRID_THICK; grid line LEFT edge sits at xForTick(t) - inset
  // SVG <line> stroke is centered on the path, so place at left+thickness/2
  const xLeft = xForTick(t) - GRID_THICK;
  const xCenter = xLeft + GRID_THICK / 2;
  out.push(
    `<line x1="${xCenter.toFixed(3)}" y1="${GRID_TOP_Y}" x2="${xCenter.toFixed(3)}" y2="${H}" ` +
    `stroke="${rgb(GRID_RGB)}" stroke-opacity="${GRID_A.toFixed(3)}" stroke-width="${GRID_THICK}" ` +
    `stroke-dasharray="4.8 3.2"/>`
  );
}

// 2. ruler bg + border + notches (rectsBg)
out.push(`<rect width="${W}" height="${RULER_H}" fill="${PANEL_2}"/>`);
out.push(`<rect y="${RULER_H - 1}" width="${W}" height="1" fill="${BORDER}"/>`);
const NOTCH_H = 12;
const notchY = RULER_H - NOTCH_H;
for (const t of rulerTicks) {
  const x = xForTick(t);
  if (x < 0 || x > W) continue;
  out.push(`<rect x="${x.toFixed(2)}" y="${notchY}" width="2" height="${NOTCH_H}" fill="${NOTCH_COLOR}"/>`);
}

// 3. dead zone (rectsBg, last in batch)
const dataEndPx = xForTick(MOCK_END_TICKS);
if (dataEndPx < W) {
  out.push(
    `<rect x="${dataEndPx}" y="${RULER_H}" width="${W - dataEndPx}" height="${H - RULER_H}" ` +
    `fill="url(#hatch-dead)"/>`
  );
}

// 4. signal pipelines (digital.wgsl: vs_single + vs_multi)
//    Drawn opaque (shader composites against bg); replicate by pre-blending.
function rowCenterY(row) { return RULER_H + ROW_H * (row + 0.5); }
const Y_GAP = 3 * DPR;                      // vertical pill gap (CSS px)
const X_GAP = 2.5 * DPR;                      // multi-bit horizontal pill gap (CSS px)
const STROKE = 2;                     // line/border thickness in CSS px (user-fixed)
const HALF_H = (ROW_H - Y_GAP) / 2;   // single+multi share same y inset

for (const seg of SEGMENTS) {
  const x0 = xForTick(seg.tStart);
  const x1 = xForTick(seg.tEnd);
  const cy = rowCenterY(seg.row);
  const top = cy - HALF_H;
  const bot = cy + HALF_H;
  const w = x1 - x0;
  const h = bot - top;
  const primary = ROW_COLORS[seg.row];
  const isSelected = seg.row === SELECTED_ROW;

  if (seg.bw === 1) {
    // ---- single-bit ----
    if (seg.mute && seg.msb !== 0) {
      // muted x/z: mute crosshatch (shader collapses hatch_primary→mute when muted)
      out.push(`<rect x="${x0}" y="${top}" width="${w}" height="${h}" fill="url(#hatch-mute)"/>`);
      if (seg.edge) {
        out.push(`<rect x="${x1 - STROKE}" y="${top}" width="${STROKE}" height="${h}" fill="${rgb(blend(MUTE_RGB, MUTE_A))}"/>`);
      }
      continue;
    }
    if (seg.mute) {
      // muted 0/1: mute-color shade + line
      const shadeAlpha = (seg.lsb !== 0 ? 0.7 : 0.2) * MUTE_A;
      out.push(`<rect x="${x0}" y="${top}" width="${w}" height="${h}" fill="${rgb(blend(MUTE_RGB, shadeAlpha))}"/>`);
      const lineY = seg.lsb !== 0 ? top : bot - STROKE;
      out.push(`<rect x="${x0}" y="${lineY}" width="${w}" height="${STROKE}" fill="${rgb(blend(MUTE_RGB, MUTE_A))}"/>`);
      if (seg.edge) {
        out.push(`<rect x="${x1 - STROKE}" y="${top}" width="${STROKE}" height="${h}" fill="${rgb(blend(MUTE_RGB, MUTE_A))}"/>`);
      }
      continue;
    }
    if (seg.msb !== 0) {
      // x or z (not muted): x/z crosshatch fill, no line/edge
      const id = seg.lsb !== 0 ? "hatch-z-single" : "hatch-x-single";
      out.push(`<rect x="${x0}" y="${top}" width="${w}" height="${h}" fill="url(#${id})"/>`);
      continue;
    }
    // 0/1
    const high = seg.lsb !== 0;
    const shadeAlpha = high ? (isSelected ? 0.8 : 0.7) : 0.2;
    if (seg.shade) {
      out.push(`<rect x="${x0}" y="${top}" width="${w}" height="${h}" fill="${rgb(blend(hexToRgb(primary), shadeAlpha))}"/>`);
    }
    const lineY = high ? top : bot - STROKE;
    out.push(`<rect x="${x0}" y="${lineY}" width="${w}" height="${STROKE}" fill="${primary}"/>`);
    if (seg.edge) {
      out.push(`<rect x="${x1 - STROKE}" y="${top}" width="${STROKE}" height="${h}" fill="${primary}"/>`);
    }
  } else {
    // ---- multi-bit pill ----
    const radius = 2 * DPR;
    const xL = x0;
    const xR = x1 - X_GAP;
    const pw = xR - xL;
    if (pw <= 0) continue;

    if (seg.mute && seg.msb !== 0) {
      // muted x/z: mute crosshatch + mute border (shader collapses hatch_primary→mute)
      const borderC = rgb(blend(MUTE_RGB, MUTE_A));
      out.push(
        `<rect x="${xL}" y="${top}" width="${pw}" height="${h}" rx="${radius}" ry="${radius}" ` +
        `fill="url(#hatch-mute)" stroke="${borderC}" stroke-width="${STROKE}" shape-rendering="geometricPrecision"/>`
      );
      continue;
    }
    if (seg.mute) {
      const fillAlpha = MUTE_A * (isSelected ? 1.0 : 0.7);
      out.push(
        `<rect x="${xL}" y="${top}" width="${pw}" height="${h}" rx="${radius}" ry="${radius}" ` +
        `fill="${rgb(blend(MUTE_RGB, fillAlpha))}" stroke="${rgb(blend(MUTE_RGB, MUTE_A))}" stroke-width="${STROKE}" shape-rendering="geometricPrecision"/>`
      );
      continue;
    }
    if (seg.msb !== 0) {
      const isZ = seg.lsb !== 0;
      const stripe = isZ ? Z_RGB : X_RGB;
      const id = isZ ? "hatch-z-multi" : "hatch-x-multi";
      // Border at hatch_primary (alpha 0.7)
      const borderC = rgb(blend(stripe, 0.7));
      out.push(
        `<rect x="${xL}" y="${top}" width="${pw}" height="${h}" rx="${radius}" ry="${radius}" ` +
        `fill="url(#${id})" stroke="${borderC}" stroke-width="${STROKE}" shape-rendering="geometricPrecision"/>`
      );
      continue;
    }
    // normal
    const shadeAlpha = isSelected ? 1.0 : 0.7;
    const fillC = rgb(blend(hexToRgb(primary), shadeAlpha));
    out.push(
      `<rect x="${xL}" y="${top}" width="${pw}" height="${h}" rx="${radius}" ry="${radius}" ` +
      `fill="${fillC}" stroke="${primary}" stroke-width="${STROKE}" shape-rendering="geometricPrecision"/>`
    );
    // text label (only if pill wide enough — App.tsx threshold: textWidthPx + 6)
    const text = formatSegmentValue(seg, seg.bw, ROW_RADIX[seg.row], ROW_ENUM[seg.row]);
    const cellW = 7.2; // approx cellLg.widthPx for 12 px JetBrains Mono
    const textWidth = text.length * cellW;
    if (pw >= textWidth + 6) {
      out.push(
        `<text x="${(xL + xR) / 2}" y="${cy + 0.5}" fill="${TEXT_WHITE}" font-weight="700" ` +
        `text-anchor="middle" dominant-baseline="central" shape-rendering="geometricPrecision">${esc(text)}</text>`
      );
    }
  }
}

// 5. ruler labels (textBody, drawn after signals)
const rulerLabelY = Math.round(RULER_H * 0.5 + 2);
for (const t of rulerTicks) {
  const x = Math.round(xForTick(t) + 3);
  out.push(
    `<text x="${x}" y="${rulerLabelY}" fill="${TEXT_2}" font-size="10" ` +
    `dominant-baseline="middle" shape-rendering="geometricPrecision">${esc(formatRulerLabel(t, rulerStep))}</text>`
  );
}

// 6. cursor + marker lines (linesFg, on top of signals)
function emitFgLine(tick, color, dashed) {
  const xLeft = xForTick(tick);
  const xCenter = xLeft + GRID_THICK / 2;
  const dashAttr = dashed ? `stroke-dasharray="4.8 3.2"` : "";
  out.push(
    `<line x1="${xCenter.toFixed(3)}" y1="${GRID_TOP_Y}" x2="${xCenter.toFixed(3)}" y2="${H}" ` +
    `stroke="${color}" stroke-width="${GRID_THICK}" ${dashAttr}/>`
  );
}
emitFgLine(MARKER_TICKS, MARKER, true);
emitFgLine(INITIAL_CURSOR_TICKS, HOT, false);

// 7. top pills + small text (rectsTop + textTop)
const PILL_H = 16;
const PAD_X = 5;
const CELL_SM = 6.0; // approx 10 px JetBrains Mono advance
function emitPill(anchorX, text, fill, textColor) {
  const pillW = text.length * CELL_SM + PAD_X * 2;
  const flipStart = W - pillW;
  const t = Math.max(0, Math.min(1, (anchorX - flipStart) / pillW));
  const pillX = Math.max(0, Math.min(W - pillW, anchorX - t * pillW));
  out.push(
    `<rect x="${pillX.toFixed(2)}" y="0" width="${pillW.toFixed(2)}" height="${PILL_H}" ` +
    `rx="3" ry="3" fill="${fill}" shape-rendering="geometricPrecision"/>`
  );
  out.push(
    `<text x="${(pillX + PAD_X).toFixed(2)}" y="${(PILL_H / 2).toFixed(2)}" fill="${textColor}" font-size="10" ` +
    `dominant-baseline="central" shape-rendering="geometricPrecision">${esc(text)}</text>`
  );
}
emitPill(xForTick(MARKER_TICKS), `M1 \u00b7 ${MARKER_TICKS.toFixed(3)} ns`, MARKER, ON_ACCENT);
emitPill(xForTick(INITIAL_CURSOR_TICKS), `${INITIAL_CURSOR_TICKS.toFixed(3)} ns`, HOT, ON_ACCENT);

out.push("</svg>");

function esc(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

const here = dirname(fileURLToPath(import.meta.url));
const dest = resolve(here, "..", "mock-canvas.svg");
writeFileSync(dest, out.join("\n"));
console.log(`wrote ${dest} (${CANVAS_W}\u00d7${CANVAS_H} CSS px, ${SEGMENTS.length} segments)`);
