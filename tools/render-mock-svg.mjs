#!/usr/bin/env node
// Render the WebGPU canvas mock as a static SVG.
// Replicates the geometry / colors produced by src/renderer/gpu/* + the
// tide-vcd-driven scene (src/renderer/hier/scene.ts) at the auto-fit viewport
// (start_ticks=0, ticks_per_pixel = MOCK_END_TICKS/W).
//
// Data is parsed from native/src/mock.vcd so this tracks the real waveform
// (the scene now packs raw VCD transitions, not a synthetic cycle model).
//
// DPR note: shader size literals (line/border thickness, gaps, radius, hatch
// spacing) are bare CSS px — the clip→framebuffer transform already scales by
// dpr (see CLAUDE.md "CSS-pixel + DPR contract"). The SVG coordinate space is
// CSS px, so these are used verbatim with NO dpr multiplier.

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));

// ----- viewport ----------------------------------------------------------
// Canvas occupies the wave column inside the body grid. Default panel widths
// from the sidecar: tree=236, active=296 → 1440-236-296 = 908 CSS px wide.
const CANVAS_W = 908;      // CSS px — DOM-derived
const CANVAS_H = 798;      // CSS px — DOM-derived
const ROW_H = 28;          // CSS var(--row-h) in index.html
const RULER_H = ROW_H;     // App.tsx: rulerHeightCSS = rowHeightCSS
const WAVE_Y_OFFSET = RULER_H; // App.tsx: vp.wave_y_offset = rulerHeightCSS
const BOTTOM_RULER_H = 24; // App.tsx BOTTOM_RULER_HEIGHT
const NOTCH_H = 12;        // App.tsx NOTCH_HEIGHT

const MOCK_CLOCK_TICK_NS = 5;
const MOCK_END_TICKS = 90;
const ticksPerPixel = MOCK_END_TICKS / CANVAS_W;
const startTicks = 0;
const xForTick = (t) => (t - startTicks) / ticksPerPixel;

// From the bundled sidecar (native/src/mock.vcd.sidecar.json): cursor only,
// no markers. TIME_DECIMALS = 2 (timescale 1 ns / 10 ps precision).
const CURSOR_TICKS = 30.633255700778644;
const TIME_DECIMALS = 2;
const SELECTED_ROW = 2;
// scene.ts RESET_HELD_TICKS — drawn as a crosshatch band in the bottom ruler.
const RESET_HELD = { tStart: 0, tEnd: 10 };

// ----- palette (App.tsx packRgba calls + index.html CSS vars) ------------
const BG = [0x1B, 0x1D, 0x21];          // canvas clear color (0.106/0.114/0.129)
const PANEL_2 = "#22252A";
const BORDER = "#2F333A";
const TEXT_2 = "#C4C3BB";                // TEXT_SECONDARY
const TEXT_WHITE = "#FFFFFF";
const ON_ACCENT = "#0F1A09";
const NOTCH_COLOR = "#868C96";
const HOT = "#F06B5B";
const GRID_RGB = [0x86, 0x8C, 0x96];
const GRID_A = 0x70 / 255;
const DEAD_RGB = [0x78, 0x7C, 0x86];     // DEAD_ZONE_GRAY rgb
const DEAD_A = 0x70 / 255;
const RESET_RGB = [0xE8, 0x6A, 0x5A];    // RESET_RED rgb
const RESET_A = 0x60 / 255;
const RESET_TEXT = "#F06B5B";            // RESET_TEXT (solid label)

// digital.wgsl shader-side constants
const X_RGB = [245, 114, 114]; // 0.9608, 0.4471, 0.4471
const Z_RGB = [255, 220, 0];   // 1.0, 0.863, 0.0
const MUTE_RGB = [120, 120, 120];
const MUTE_A = 0.6;
const X_MULTI_A = 0.7;
const Z_MULTI_A = 0.7;

// ----- per-row display config (port of scene.ts ROWS) --------------------
// path matches the VCD var path; gate mutes the row when the gate isn't logic-1.
const W = "top.keysched.waves";
const ENUM_STATE = { 0: "IDLE", 1: "BUSY", 2: "WAIT" };
const ROWS = [
  { row: 0,  radix: "bin", role: "clock", color: "#72F5DF", path: `${W}.clk` },
  { row: 1,  radix: "bin", role: "reset", color: "#F06B5B", path: `${W}.rst` },
  { row: 2,  radix: "dec", color: "#B48CFF", path: `${W}.state[1:0]`,       enum: ENUM_STATE },
  { row: 3,  radix: "dec", color: "#B48CFF", path: `${W}.cycle_count[7:0]` },
  { row: 4,  radix: "bin", role: "valid", color: "#F4A698", path: `${W}.in_valid` },
  { row: 5,  radix: "hex", color: "#F4A698", path: `${W}.in_data[7:0]`,     gate: `${W}.in_valid` },
  { row: 6,  radix: "hex", color: "#F4A698", path: `${W}.in_addr[15:0]`,    gate: `${W}.in_valid` },
  { row: 7,  radix: "bin", role: "valid", color: "#57C88A", path: `${W}.out_valid` },
  { row: 8,  radix: "hex", color: "#57C88A", path: `${W}.out_data[31:0]`,   gate: `${W}.out_valid` },
  { row: 9,  radix: "dec", color: "#E6B14E", path: `${W}.fifo_level[3:0]` },
  { row: 10, radix: "bin", color: "#E6B14E", path: `${W}.fifo_empty` },
  { row: 11, radix: "hex", color: "#4FD2BD", path: `${W}.dbus[7:0]` },
  { row: 12, radix: "bin", color: "#4FD2BD", path: "derived.busy" },
  { row: 13, radix: "bin", color: "#4FD2BD", path: "derived.done" },
];

// ----- VCD parser --------------------------------------------------------
// Build path→{sym,width}, then per-symbol transition lists ({t, lsb, msb}).
function bitsFromVcd(s, width) {
  const pad = s[0] === "x" || s[0] === "z" ? s[0] : "0";
  let str = s;
  while (str.length < width) str = pad + str;
  if (str.length > width) str = str.slice(str.length - width);
  let lsb = 0, msb = 0;
  for (let b = 0; b < width; b++) {
    const ch = str[width - 1 - b];
    let l, m;
    if (ch === "0") { l = 0; m = 0; }
    else if (ch === "1") { l = 1; m = 0; }
    else if (ch === "x" || ch === "X") { l = 0; m = 1; }
    else { l = 1; m = 1; } // z
    lsb |= l << b; msb |= m << b;
  }
  return { lsb: lsb >>> 0, msb: msb >>> 0 };
}

function parseVcd(text) {
  const lines = text.split(/\r?\n/);
  const byPath = new Map();   // full path → { sym, width }
  const widthBySym = new Map();
  const scope = [];
  let i = 0;
  for (; i < lines.length; i++) {
    const ln = lines[i].trim();
    if (ln.startsWith("$scope")) scope.push(ln.split(/\s+/)[2]);
    else if (ln.startsWith("$upscope")) scope.pop();
    else if (ln.startsWith("$var")) {
      const p = ln.split(/\s+/); // $var <type> <width> <sym> <name...> $end
      const width = parseInt(p[2], 10);
      const sym = p[3];
      const name = p.slice(4, p.length - 1).join("");
      byPath.set([...scope, name].join("."), { sym, width });
      widthBySym.set(sym, width);
    } else if (ln.startsWith("$enddefinitions")) { i++; break; }
  }
  const trans = new Map(); // sym → [{ t, lsb, msb }]
  let t = 0;
  for (; i < lines.length; i++) {
    const ln = lines[i].trim();
    if (!ln || ln === "$dumpvars" || ln === "$end") continue;
    if (ln[0] === "#") { t = parseInt(ln.slice(1), 10); continue; }
    let sym, valStr;
    if (ln[0] === "b" || ln[0] === "B") {
      const sp = ln.indexOf(" ");
      valStr = ln.slice(1, sp);
      sym = ln.slice(sp + 1).trim();
    } else {
      valStr = ln[0];
      sym = ln.slice(1).trim();
    }
    const width = widthBySym.get(sym);
    if (width == null) continue;
    const b = bitsFromVcd(valStr, width);
    if (!trans.has(sym)) trans.set(sym, []);
    trans.get(sym).push({ t, lsb: b.lsb, msb: b.msb });
  }
  return { byPath, trans };
}

const VCD = parseVcd(readFileSync(resolve(here, "..", "native", "src", "mock.vcd"), "utf8"));

function symForPath(path) {
  const info = VCD.byPath.get(path);
  if (!info) throw new Error(`VCD path not found: ${path}`);
  return info;
}
// Value (lsb,msb) of a symbol at tick t: last transition with t' <= t.
function valueAtTick(sym, t) {
  const list = VCD.trans.get(sym);
  if (!list || list.length === 0) return null;
  let v = list[0];
  for (const e of list) { if (e.t <= t) v = e; else break; }
  return v;
}
// A gated row is muted whenever its gate isn't exactly logic-1 (pack.zig).
function gateMutedAt(gateSym, t) {
  const v = valueAtTick(gateSym, t);
  if (!v) return true;
  return !(v.lsb === 1 && v.msb === 0);
}

// ----- segment builder (port of pack.zig packQuery) ----------------------
// Walk a symbol's transitions; each becomes one segment [t_i, t_{i+1} | end).
// Consecutive equal (value, mute) runs are coalesced (tide stores one entry per
// real transition; the mock VCD has a couple redundant rewrites).
function buildRowSegments(cfg) {
  const { sym, width } = symForPath(cfg.path);
  const gate = cfg.gate ? symForPath(cfg.gate).sym : null;
  const isClock = cfg.role === "clock";
  const shaded = !isClock;
  const raw = VCD.trans.get(sym) || [];

  // Annotate with mute, then coalesce equal (lsb,msb,mute) runs.
  const ann = raw.map((e) => ({
    t: e.t, lsb: e.lsb, msb: e.msb,
    mute: gate ? gateMutedAt(gate, e.t) : false,
  }));
  const merged = [];
  for (const e of ann) {
    const last = merged[merged.length - 1];
    if (last && last.lsb === e.lsb && last.msb === e.msb && last.mute === e.mute) continue;
    merged.push(e);
  }

  const segs = [];
  for (let i = 0; i < merged.length; i++) {
    const e = merged[i];
    const tStart = e.t;
    const tEnd = i + 1 < merged.length ? merged[i + 1].t : MOCK_END_TICKS;
    const hasNext = i + 1 < merged.length;
    let drawRight = hasNext;
    let rising = false, risingLeft = false;
    if (isClock) {
      const val = e.lsb; // clock is 2-state, msb == 0
      rising = val === 0 && hasNext;
      risingLeft = val === 1;
    } else if (drawRight && width === 1) {
      // Single-bit transitions touching x/z have no clean edge — suppress it.
      const next = merged[i + 1];
      if (e.msb !== 0 || next.msb !== 0) drawRight = false;
    }
    segs.push({
      row: cfg.row, bw: width, tStart, tEnd,
      lsb: e.lsb, msb: e.msb,
      shade: shaded, edge: drawRight, mute: e.mute,
      rising, risingLeft,
    });
  }
  return segs;
}

const SEGMENTS = ROWS.flatMap(buildRowSegments);

// ----- value formatting (port of App.tsx formatSegmentValue) -------------
function formatSegmentValue(value, bitWidth, radix, enumLabels) {
  if (!value) return "-";
  const hasX = (value.msb & ~value.lsb) >>> 0;
  const hasZ = (value.msb & value.lsb) >>> 0;
  if (hasX || hasZ) {
    const bitChar = (bit) => {
      const l = (value.lsb >>> bit) & 1;
      const m = (value.msb >>> bit) & 1;
      if (m === 0) return l === 0 ? "0" : "1";
      return l === 0 ? "X" : "Z";
    };
    if (bitWidth === 1) return bitChar(0);
    let anyX = false, anyZ = false, anyDef = false;
    for (let bit = 0; bit < bitWidth; bit++) {
      const c = bitChar(bit);
      if (c === "X") anyX = true;
      else if (c === "Z") anyZ = true;
      else anyDef = true;
    }
    if ((radix === "hex" || radix === "dec") && !anyDef && !(anyX && anyZ)) {
      return anyZ ? "Z" : "X";
    }
    if (radix === "hex") {
      const digits = [];
      for (let hi = bitWidth - 1; hi >= 0; hi -= 4) {
        let nib = 0, nibX = false, nibZ = false, allDef = true;
        for (let b = hi; b > hi - 4 && b >= 0; b--) {
          const c = bitChar(b);
          nib = (nib << 1) | (c === "1" ? 1 : 0);
          if (c === "X") { nibX = true; allDef = false; }
          else if (c === "Z") { nibZ = true; allDef = false; }
        }
        if (allDef) digits.push(nib.toString(16).toUpperCase());
        else if (nibX && nibZ) digits.push("X");
        else digits.push(nibZ ? "Z" : "X");
      }
      return `0x${digits.join("")}`;
    }
    const chars = [];
    for (let bit = bitWidth - 1; bit >= 0; bit--) chars.push(bitChar(bit));
    return `0b${chars.join("")}`;
  }
  const val = value.lsb >>> 0;
  if (enumLabels && enumLabels[val] != null) return enumLabels[val];
  if (bitWidth === 1) return String(val);
  if (radix === "hex") return `0x${val.toString(16).toUpperCase()}`;
  if (radix === "dec") return String(val);
  return `0b${val.toString(2).padStart(bitWidth, "0")}`;
}

const ENUM_BY_ROW = Object.fromEntries(ROWS.filter((r) => r.enum).map((r) => [r.row, r.enum]));
const RADIX_BY_ROW = Object.fromEntries(ROWS.map((r) => [r.row, r.radix]));

// ----- ruler ticks (App.tsx) ---------------------------------------------
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
// Clock positive edges (rising): odd multiples of the half-period (5,15,...).
const CLOCK_EDGE_TICKS = [];
for (let t = MOCK_CLOCK_TICK_NS; t < MOCK_END_TICKS; t += 2 * MOCK_CLOCK_TICK_NS) {
  CLOCK_EDGE_TICKS.push(t);
}

// ----- color helpers -----------------------------------------------------
function hexToRgb(hex) {
  const h = hex.replace("#", "");
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}
function blendRgb(rgbc, alpha, base = BG) {
  const [r, g, b] = rgbc;
  return [
    Math.round(base[0] + (r - base[0]) * alpha),
    Math.round(base[1] + (g - base[1]) * alpha),
    Math.round(base[2] + (b - base[2]) * alpha),
  ];
}
const rgb = (c) => `rgb(${c[0]},${c[1]},${c[2]})`;
const blend = (rgbc, alpha) => blendRgb(rgbc, alpha);

// ----- SVG emission ------------------------------------------------------
const out = [];
const H = CANVAS_H, Wd = CANVAS_W;
out.push(
  `<svg xmlns="http://www.w3.org/2000/svg" width="${Wd}" height="${H}" viewBox="0 0 ${Wd} ${H}" ` +
  `font-family="'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, Consolas, monospace" ` +
  `font-size="12" shape-rendering="crispEdges">`
);

// ---- crosshatch patterns ------------------------------------------------
// digital.wgsl/rect.wgsl hatch: coord = (x + y) / spacing(8 CSS px); a stripe
// is "on" where abs(fract(coord)-0.5) < duty/2. Lines of constant (x+y) run at
// -45°; perpendicular repeat = spacing/√2 ≈ 5.657 px, stripe = duty × repeat.
const HATCH_REPEAT = 8 / Math.SQRT2;          // ≈ 5.657 px perpendicular period
const HATCH_DUTY_DIGITAL = 1 / 3;             // digital.wgsl hatch_thickness
const HATCH_DUTY_RECT = 0.2;                  // rect.wgsl thickness

// Vertical stripe of width `w` in a tile `HATCH_REPEAT` wide, rotated 45° →
// diagonal stripes matching the shader. `bgFill` opaquely backs the tile when
// the hatch must occlude what's beneath it (signal pills over grid lines).
function emitHatch(id, stripeColor, stripeW, bgFill) {
  const bg = bgFill ? `<rect width="${HATCH_REPEAT}" height="${HATCH_REPEAT}" fill="${bgFill}"/>` : "";
  return (
    `<pattern id="${id}" width="${HATCH_REPEAT.toFixed(4)}" height="${HATCH_REPEAT.toFixed(4)}" ` +
    `patternUnits="userSpaceOnUse" patternTransform="rotate(45)">${bg}` +
    `<rect width="${stripeW.toFixed(4)}" height="${HATCH_REPEAT.toFixed(4)}" fill="${stripeColor}"/></pattern>`
  );
}
const DW = HATCH_REPEAT * HATCH_DUTY_DIGITAL;  // digital stripe width
const RW = HATCH_REPEAT * HATCH_DUTY_RECT;     // rect stripe width
out.push("<defs>");
// Signal x/z hatches occlude the grid, so back the tile with the canvas bg and
// pre-blend the stripe against it (shader output is opaque).
out.push(emitHatch("hatch-x-single", rgb(blend(X_RGB, 1.0)), DW, rgb(BG)));
out.push(emitHatch("hatch-z-single", rgb(blend(Z_RGB, 1.0)), DW, rgb(BG)));
out.push(emitHatch("hatch-x-multi", rgb(blend(X_RGB, X_MULTI_A)), DW, rgb(BG)));
out.push(emitHatch("hatch-z-multi", rgb(blend(Z_RGB, Z_MULTI_A)), DW, rgb(BG)));
out.push(emitHatch("hatch-mute", rgb(blend(MUTE_RGB, MUTE_A)), DW, rgb(BG)));
// Dead-zone hatch sits over canvas bg (transparent gaps); reset hatch sits over
// the bottom-ruler PANEL_2 band. Pre-blend each stripe against its backdrop.
out.push(emitHatch("hatch-dead", rgb(blend(DEAD_RGB, DEAD_A)), RW, null));
out.push(emitHatch("hatch-reset", rgb(blendRgb(RESET_RGB, RESET_A, hexToRgb(PANEL_2))), RW, null));
out.push("</defs>");

// 0. canvas clear
out.push(`<rect width="${Wd}" height="${H}" fill="${rgb(BG)}"/>`);

// 1. grid lines (linesBg) — dashed verticals at visible rising clock edges.
// lines.wgsl centers the 2.5px line on x_px and starts it at y=8 (inside the
// would-be pill); dash period 8 / 60% on → "4.8 3.2".
const LINE_THICK = 2.5;
const LINE_TOP_Y = 8;
const DASH = "4.8 3.2";
for (const t of CLOCK_EDGE_TICKS) {
  const x = xForTick(t);
  out.push(
    `<line x1="${x.toFixed(3)}" y1="${LINE_TOP_Y}" x2="${x.toFixed(3)}" y2="${H}" ` +
    `stroke="${rgb(GRID_RGB)}" stroke-opacity="${GRID_A.toFixed(3)}" stroke-width="${LINE_THICK}" ` +
    `stroke-dasharray="${DASH}"/>`
  );
}

// 2. top ruler bg + border + notches (rectsBg)
out.push(`<rect width="${Wd}" height="${RULER_H}" fill="${PANEL_2}"/>`);
out.push(`<rect y="${RULER_H - 1}" width="${Wd}" height="1" fill="${BORDER}"/>`);
const notchY = RULER_H - NOTCH_H;
for (const t of rulerTicks) {
  out.push(`<rect x="${(xForTick(t) - 1).toFixed(2)}" y="${notchY}" width="2" height="${NOTCH_H}" fill="${NOTCH_COLOR}"/>`);
}

// 3. dead zone (only when zoomed out past data end — at auto-fit it's empty)
const dataEndPx = xForTick(MOCK_END_TICKS);
if (dataEndPx < Wd) {
  out.push(
    `<rect x="${dataEndPx}" y="${RULER_H}" width="${Wd - dataEndPx}" height="${H - RULER_H}" ` +
    `fill="url(#hatch-dead)"/>`
  );
}

// 4. bottom ruler band + border + notches + reset region (rectsBg)
const bottomRulerTop = H - BOTTOM_RULER_H;
out.push(`<rect y="${bottomRulerTop}" width="${Wd}" height="${BOTTOM_RULER_H}" fill="${PANEL_2}"/>`);
out.push(`<rect y="${bottomRulerTop}" width="${Wd}" height="1" fill="${BORDER}"/>`);
for (const t of rulerTicks) {
  out.push(`<rect x="${(xForTick(t) - 1).toFixed(2)}" y="${H - NOTCH_H}" width="2" height="${NOTCH_H}" fill="${NOTCH_COLOR}"/>`);
}
// Reset-held region: red crosshatch over the bottom ruler band (transparent
// gaps reveal the PANEL_2 band beneath).
const arrowY = bottomRulerTop + (BOTTOM_RULER_H - NOTCH_H) * 0.5;
{
  const rx0 = xForTick(RESET_HELD.tStart);
  const rx1 = xForTick(RESET_HELD.tEnd);
  out.push(`<rect x="${rx0}" y="${bottomRulerTop}" width="${(rx1 - rx0).toFixed(2)}" height="${BOTTOM_RULER_H}" fill="url(#hatch-reset)"/>`);
  // "RESET" label centered in the band if it fits (cellSm ≈ 6 px advance).
  const CELL_SM = 6.0;
  const label = "RESET";
  const textW = label.length * CELL_SM;
  if (rx1 - rx0 > textW + 4) {
    out.push(
      `<text x="${((rx0 + rx1) * 0.5).toFixed(2)}" y="${arrowY.toFixed(2)}" fill="${RESET_TEXT}" font-size="10" ` +
      `text-anchor="middle" dominant-baseline="central" shape-rendering="geometricPrecision">${esc(label)}</text>`
    );
  }
}

// 5. signal pipelines (digital.wgsl: vs_single + vs_multi)
//    Drawn opaque (shader composites against bg); replicate by pre-blending.
function rowCenterY(row) { return WAVE_Y_OFFSET + ROW_H * (row + 0.5); }
const Y_GAP = 4;                      // digital.wgsl ygap_px (bare CSS px)
const X_GAP = 2;                      // digital.wgsl xgap_px, multi only
const STROKE = 2;                     // fs_single line_thickness_px
const HALF_H = (ROW_H - Y_GAP) / 2;   // single + multi share the same y inset

// Rising-edge caret on the clock: "^" centered on the edge, apex at the pill
// top, biased left by half a line width (digital.wgsl caret_sdf).
function emitClockCaret(tick, color) {
  const armLen = 8.0, halfAngle = 40 * Math.PI / 180;
  const dx = armLen * Math.sin(halfAngle);   // ≈ 5.14
  const dy = armLen * Math.cos(halfAngle);   // ≈ 6.13
  const apexX = xForTick(tick) - STROKE * 0.5;
  const apexY = rowCenterY(0) - HALF_H;      // pill top
  out.push(
    `<polyline points="${(apexX - dx).toFixed(2)},${(apexY + dy).toFixed(2)} ${apexX.toFixed(2)},${apexY.toFixed(2)} ${(apexX + dx).toFixed(2)},${(apexY + dy).toFixed(2)}" ` +
    `fill="none" stroke="${color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" shape-rendering="geometricPrecision"/>`
  );
}

const ROW_COLOR = Object.fromEntries(ROWS.map((r) => [r.row, r.color]));
const caretQueue = []; // clock carets drawn after the clock line so they sit on top

for (const seg of SEGMENTS) {
  const x0 = xForTick(seg.tStart);
  const x1 = xForTick(seg.tEnd);
  const cy = rowCenterY(seg.row);
  const top = cy - HALF_H;
  const w = x1 - x0;
  const h = HALF_H * 2;
  const primary = ROW_COLOR[seg.row];
  const isSelected = seg.row === SELECTED_ROW;

  if (seg.bw === 1) {
    // ---- single-bit ----
    if (seg.mute && seg.msb !== 0) {
      out.push(`<rect x="${x0}" y="${top}" width="${w}" height="${h}" fill="url(#hatch-mute)"/>`);
      if (seg.edge) out.push(`<rect x="${x1 - STROKE}" y="${top}" width="${STROKE}" height="${h}" fill="${rgb(blend(MUTE_RGB, MUTE_A))}"/>`);
      continue;
    }
    if (seg.mute) {
      const shadeAlpha = (seg.lsb !== 0 ? 0.7 : 0.2) * MUTE_A;
      out.push(`<rect x="${x0}" y="${top}" width="${w}" height="${h}" fill="${rgb(blend(MUTE_RGB, shadeAlpha))}"/>`);
      const lineY = seg.lsb !== 0 ? top : top + h - STROKE;
      out.push(`<rect x="${x0}" y="${lineY}" width="${w}" height="${STROKE}" fill="${rgb(blend(MUTE_RGB, MUTE_A))}"/>`);
      if (seg.edge) out.push(`<rect x="${x1 - STROKE}" y="${top}" width="${STROKE}" height="${h}" fill="${rgb(blend(MUTE_RGB, MUTE_A))}"/>`);
      continue;
    }
    if (seg.msb !== 0) {
      // x or z (not muted): crosshatch fill, no line/edge.
      const id = seg.lsb !== 0 ? "hatch-z-single" : "hatch-x-single";
      out.push(`<rect x="${x0}" y="${top}" width="${w}" height="${h}" fill="url(#${id})"/>`);
      continue;
    }
    // 0/1
    const high = seg.lsb !== 0;
    if (seg.shade) {
      const shadeAlpha = high ? (isSelected ? 0.8 : 0.7) : 0.2;
      out.push(`<rect x="${x0}" y="${top}" width="${w}" height="${h}" fill="${rgb(blend(hexToRgb(primary), shadeAlpha))}"/>`);
    }
    const lineY = high ? top : top + h - STROKE;
    out.push(`<rect x="${x0}" y="${lineY}" width="${w}" height="${STROKE}" fill="${primary}"/>`);
    if (seg.edge) out.push(`<rect x="${x1 - STROKE}" y="${top}" width="${STROKE}" height="${h}" fill="${primary}"/>`);
    if (seg.rising) caretQueue.push({ tick: seg.tEnd, color: primary });
  } else {
    // ---- multi-bit pill ----
    const radius = 4;                 // fs_multi radius (bare CSS px)
    const xL = x0;
    const xR = x1 - X_GAP;
    const pw = xR - xL;
    if (pw <= 0) continue;

    if (seg.mute && seg.msb !== 0) {
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
      const borderC = rgb(blend(stripe, 0.7));
      out.push(
        `<rect x="${xL}" y="${top}" width="${pw}" height="${h}" rx="${radius}" ry="${radius}" ` +
        `fill="url(#${id})" stroke="${borderC}" stroke-width="${STROKE}" shape-rendering="geometricPrecision"/>`
      );
    } else {
      const shadeAlpha = isSelected ? 1.0 : 0.7;
      out.push(
        `<rect x="${xL}" y="${top}" width="${pw}" height="${h}" rx="${radius}" ry="${radius}" ` +
        `fill="${rgb(blend(hexToRgb(primary), shadeAlpha))}" stroke="${primary}" stroke-width="${STROKE}" shape-rendering="geometricPrecision"/>`
      );
    }
    // Value label (App.tsx: muted pills are skipped; non-muted x/z still label).
    const valueLM = valueAtTick(symForPath(ROWS[seg.row].path).sym, seg.tStart);
    const text = formatSegmentValue(valueLM, seg.bw, RADIX_BY_ROW[seg.row], ENUM_BY_ROW[seg.row]);
    const cellW = 7.2; // approx cellLg advance for 12 px JetBrains Mono
    if (pw >= text.length * cellW + 6) {
      out.push(
        `<text x="${((xL + xR) / 2).toFixed(2)}" y="${(cy + 0.5).toFixed(2)}" fill="${TEXT_WHITE}" font-weight="700" ` +
        `text-anchor="middle" dominant-baseline="central" shape-rendering="geometricPrecision">${esc(text)}</text>`
      );
    }
  }
}
// Clock carets last (sit on top of the clock line/edges).
for (const c of caretQueue) emitClockCaret(c.tick, c.color);

// 6. ruler labels — top + bottom (textBody, after signals)
const rulerLabelY = Math.round(RULER_H * 0.5 + 2);
const bottomLabelY = Math.round(bottomRulerTop + BOTTOM_RULER_H * 0.5 + 2);
for (const t of rulerTicks) {
  const x = Math.round(xForTick(t) + 5);
  const label = formatRulerLabel(t, rulerStep);
  out.push(`<text x="${x}" y="${rulerLabelY}" fill="${TEXT_2}" font-size="10" dominant-baseline="middle" shape-rendering="geometricPrecision">${esc(label)}</text>`);
  out.push(`<text x="${x}" y="${bottomLabelY}" fill="${TEXT_2}" font-size="10" dominant-baseline="middle" shape-rendering="geometricPrecision">${esc(label)}</text>`);
}

// 7. cursor line (linesFg) — solid HOT, centered on the tick, no marker.
{
  const x = xForTick(CURSOR_TICKS);
  out.push(`<line x1="${x.toFixed(3)}" y1="${LINE_TOP_Y}" x2="${x.toFixed(3)}" y2="${H}" stroke="${HOT}" stroke-width="${LINE_THICK}"/>`);
}

// 8. cursor flag pill (rectsTop + textTop) — squared bottom corner where the
// line attaches (rect.wgsl), radius 3, height 14.
const PILL_H = 14;
const PAD_X = 5;
const CELL_SM = 6.0;
const PILL_R = 3; // rect.wgsl ROUND_RADIUS_PX
function roundedFlagPath(x, y, w, h, r, squareBL, squareBR) {
  const blR = squareBL ? 0 : r;
  const brR = squareBR ? 0 : r;
  return (
    `M${(x + r).toFixed(2)},${y.toFixed(2)} ` +
    `H${(x + w - r).toFixed(2)} A${r},${r} 0 0 1 ${(x + w).toFixed(2)},${(y + r).toFixed(2)} ` +
    `V${(y + h - brR).toFixed(2)} ` + (brR ? `A${r},${r} 0 0 1 ${(x + w - r).toFixed(2)},${(y + h).toFixed(2)} ` : `H${(x + w).toFixed(2)} V${(y + h).toFixed(2)} `) +
    `H${(x + blR).toFixed(2)} ` + (blR ? `A${r},${r} 0 0 1 ${x.toFixed(2)},${(y + h - r).toFixed(2)} ` : `H${x.toFixed(2)} `) +
    `V${(y + r).toFixed(2)} A${r},${r} 0 0 1 ${(x + r).toFixed(2)},${y.toFixed(2)} Z`
  );
}
{
  const text = `${CURSOR_TICKS.toFixed(TIME_DECIMALS)} ns`;
  const pillW = text.length * CELL_SM + PAD_X * 2;
  const x = xForTick(CURSOR_TICKS);
  const lineHalf = LINE_THICK * 0.5;
  const flipStart = Wd - pillW;
  const tt = Math.max(0, Math.min(1, (x - flipStart) / pillW));
  const anchor = x + (2 * tt - 1) * lineHalf;
  const pillX = Math.max(0, Math.min(Wd - pillW, anchor - tt * pillW));
  const lineOnRight = tt >= 0.5;
  out.push(
    `<path d="${roundedFlagPath(pillX, 0, pillW, PILL_H, PILL_R, !lineOnRight, lineOnRight)}" fill="${HOT}" shape-rendering="geometricPrecision"/>`
  );
  out.push(
    `<text x="${(pillX + PAD_X).toFixed(2)}" y="${(PILL_H / 2).toFixed(2)}" fill="${ON_ACCENT}" font-size="10" ` +
    `dominant-baseline="central" shape-rendering="geometricPrecision">${esc(text)}</text>`
  );
}

out.push("</svg>");

function esc(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

const dest = resolve(here, "..", "mock-canvas.svg");
writeFileSync(dest, out.join("\n"));
console.log(`wrote ${dest} (${CANVAS_W}×${CANVAS_H} CSS px, ${SEGMENTS.length} segments)`);
