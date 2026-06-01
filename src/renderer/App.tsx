import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ArrowLeftToLine, ArrowRightToLine, ChevronFirst, ChevronLast, ChevronLeft, ChevronRight, Clock, Grid2x2, Maximize, Minus, PanelLeftClose, PanelLeftOpen, Plus, X } from "lucide-react";
import { ActiveSignal, type ActiveSignalKind } from "./ActiveSignal";
import { ColorPicker } from "./ColorPicker";
import { SignalTreeView } from "./SignalTree";
import { initGPU, resizeCanvas, GPUInitError } from "./gpu/device";
import { createDigitalRenderer } from "./gpu/digital";
import { renderFrame } from "./gpu/frame";
import { createColorBuffer, writeRowColors } from "./gpu/colors";
import { MOCK_CLOCK_TICK_NS, MOCK_END_TICKS, unpackSegmentHeaders } from "./gpu/data";
import { createTextRenderer, packRgba, MAX_GLYPHS, ATLAS_MIDDLE_DOT } from "./gpu/text";
import { createLineRenderer } from "./gpu/lines";
import { createRectRenderer } from "./gpu/rect";
import { INITIAL, SCENE, RESET_HELD_TICKS, buildPackSpecs, type ActiveSignalRef, type Radix } from "./hier/scene";
import { getSignal } from "./hier/hierarchy";
import type { NodeId, Timescale, TimeUnit } from "./hier/types";
import { serializeSidecar, sidecarPath, sidecarToString, writeSidecarFile } from "./hier/sidecar";
import { getMockSegments, getValueAt } from "./native";

function activeSignalKind(ref: ActiveSignalRef): ActiveSignalKind {
  if (ref.role === "clock") return "clock";
  if (ref.role === "reset") return "reset";
  if (ref.role === "valid") return "valid";
  if (ref.derivedExpr) return "derived";
  return "signal";
}

const ZOOM_PER_DELTA_Y = 0.001; // Math.exp() factor per wheel deltaY unit
const ZOOM_ANIM_MS = 120; // duration of button-driven zoom in/out/fit easing
const easeOutCubic = (t: number) => 1 - Math.pow(1 - t, 3);
const MAX_MARKERS = 16; // size of the pre-allocated pill/line render pool
const MARKER_GRAB_PX = 5; // pointer slop for grabbing a marker line

interface Marker {
  id: number;     // unique, monotonic; also drives the Mn name
  name: string;
  tick: number;
  color: number;  // packed rgba
}

// Initial markers/selection from the sidecar (INITIAL.markers carries packed
// colors already). Ids are assigned sequentially; the sidecar does not persist
// them (they're runtime-monotonic so deletes never reuse a name).
const INITIAL_MARKERS: Marker[] = INITIAL.markers.map((m, i) => ({
  id: i + 1, name: m.name, tick: m.tick, color: m.color,
}));
const INITIAL_SELECTED_MARKER: number | null =
  INITIAL.markers.findIndex((m) => m.selected) >= 0
    ? INITIAL.markers.findIndex((m) => m.selected) + 1
    : null;
const INITIAL_MARKER_SEQ = INITIAL_MARKERS.length + 1;

// Decoded (lsb, msb) value of a signal at a tick, via the native tide query.
// Replaces the old scan over a JS segment list.
type SegValueLM = { lsb: number; msb: number };
function valueAtTick(handle: string, tick: number): SegValueLM | undefined {
  return getValueAt(handle, Math.floor(tick)) ?? undefined;
}

function formatSegmentValue(
  value: SegValueLM | undefined,
  bitWidth: number,
  radix: Radix,
  enumLabels?: Map<number, string>,
): string {
  if (!value) return "-";
  const hasX = (value.msb & ~value.lsb) >>> 0;
  const hasZ = (value.msb & value.lsb) >>> 0;
  // Any X/Z: render in the signal's own radix (matching its 2-state segments)
  // rather than always falling back to binary.
  if (hasX || hasZ) {
    // Per-bit 2-state classification: "0" | "1" | "X" | "Z".
    const bitChar = (bit: number): string => {
      const l = (value.lsb >>> bit) & 1;
      const m = (value.msb >>> bit) & 1;
      if (m === 0) return l === 0 ? "0" : "1";
      return l === 0 ? "X" : "Z";
    };
    if (bitWidth === 1) return bitChar(0);
    // Classify the whole value (any defined bit / any X / any Z).
    let anyX = false, anyZ = false, anyDef = false;
    for (let bit = 0; bit < bitWidth; bit++) {
      const c = bitChar(bit);
      if (c === "X") anyX = true;
      else if (c === "Z") anyZ = true;
      else anyDef = true;
    }
    // Uniformly-unknown value reads better as a bare "X"/"Z" than a prefixed
    // "0xXX" (the 0x's x collides with the digits). Hex/dec only — binary keeps
    // its per-bit form. The 0x prefix is only kept below when a real digit
    // anchors it.
    if ((radix === "hex" || radix === "dec") && !anyDef && !(anyX && anyZ)) {
      return anyZ ? "Z" : "X";
    }
    if (radix === "hex") {
      // Group into nibbles (MSB first). A nibble of pure X or pure Z prints
      // "X"/"Z"; a nibble mixing unknown with known bits also prints "X".
      const digits: string[] = [];
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
    // Binary (and the decimal mixed-value fallback): per-bit.
    const chars: string[] = [];
    for (let bit = bitWidth - 1; bit >= 0; bit--) chars.push(bitChar(bit));
    return `0b${chars.join("")}`;
  }
  const val = value.lsb >>> 0;
  if (enumLabels) {
    const label = enumLabels.get(val);
    if (label) return label;
  }
  if (bitWidth === 1) return String(val);
  if (radix === "hex") return `0x${val.toString(16).toUpperCase()}`;
  if (radix === "dec") return String(val);
  return `0b${val.toString(2).padStart(bitWidth, "0")}`;
}

// Precompute enum label maps per row (value → label) for any active signal
// whose declaration carries an enumTypeId.
const ENUM_LABELS_BY_ROW = new Map<number, Map<number, string>>();
for (const ref of SCENE.activeSignals) {
  const sig = getSignal(SCENE.hierarchy, ref.signalId);
  if (sig.enumTypeId == null) continue;
  const enumType = SCENE.hierarchy.enumTypes.get(sig.enumTypeId);
  if (!enumType) continue;
  const m = new Map<number, string>();
  for (const mem of enumType.members) m.set(parseInt(mem.raw, 2), mem.label);
  ENUM_LABELS_BY_ROW.set(ref.row, m);
}

// Native packed scene: GPU buffers (multi/single segments + RowInfo + value
// pools) plus the data the CPU still needs. Built once at module load; reused by
// both the label pass below and the GPU pipeline setup in the effect.
const NATIVE = getMockSegments(buildPackSpecs());

interface MultiBitLabel {
  row: number;
  tStart: number;
  tEnd: number;
  text: string;
}

const FLAG_MUTE = 1 << 20;
// Value labels drawn inside multi-bit pills. The segment timing/flags come from
// the native multi-pipeline buffer; the value at each segment's start tick comes
// from a tide point query (getValueAt).
const MULTI_BIT_LABELS: MultiBitLabel[] = unpackSegmentHeaders(NATIVE.multi, NATIVE.multiCount)
  .filter((s) => (s.rowFlags & FLAG_MUTE) === 0)
  .map((s) => {
    const row = s.rowFlags & 0xffff;
    const ref = SCENE.activeSignals.find((r) => r.row === row)!;
    const sig = getSignal(SCENE.hierarchy, ref.signalId);
    const value = valueAtTick(sig.handle, s.tStart);
    return { row, tStart: s.tStart, tEnd: s.tEnd, text: formatSegmentValue(value, sig.bitWidth, ref.radix, ENUM_LABELS_BY_ROW.get(row)) };
  });

const TEXT_WHITE = packRgba(0xff, 0xff, 0xff, 0xff);
const TEXT_DARK = packRgba(0x14, 0x15, 0x17, 0xff); // matches --bg
const TEXT_SECONDARY = packRgba(0xc4, 0xc3, 0xbb, 0xff);
const ON_ACCENT = packRgba(0x0f, 0x1a, 0x09, 0xff);
const PANEL_2 = packRgba(0x22, 0x25, 0x2a, 0xff);
const BORDER = packRgba(0x2f, 0x33, 0x3a, 0xff);
const HOT = packRgba(0xf0, 0x6b, 0x5b, 0xff);
const MARKER = packRgba(0x4f, 0xd2, 0xbd, 0xff);
// Cycled per new marker so adjacent markers read apart. Avoids HOT (cursor red).
const MARKER_PALETTE = [
  MARKER,                            // teal
  packRgba(0xe8, 0xb3, 0x4f, 0xff),  // amber
  packRgba(0xb4, 0x8c, 0xff, 0xff),  // purple
  packRgba(0x72, 0xf5, 0xb4, 0xff),  // green
  packRgba(0x72, 0x7b, 0xf5, 0xff),  // blue
];
// Pick the higher-contrast text color (white vs near-black canvas bg) against
// the pill's effective fill. Pills render at ~70% color over the dark bg when
// not selected, so pre-blend before measuring luminance.
const PILL_BLEND = 0.7;
const BG_LUM = 0.2126 * 0.106 + 0.7152 * 0.114 + 0.0722 * 0.129;
function pickTextColor(hex: string): number {
  const h = hex.replace("#", "");
  const r = parseInt(h.slice(0, 2), 16) / 255;
  const g = parseInt(h.slice(2, 4), 16) / 255;
  const b = parseInt(h.slice(4, 6), 16) / 255;
  const colorLum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  const fillLum = (1 - PILL_BLEND) * BG_LUM + PILL_BLEND * colorLum;
  return fillLum > 0.5 ? TEXT_DARK : TEXT_WHITE;
}
// Unpack a packRgba color (r in LSB) back to a CSS hex string for DOM pills, so
// marker pills in the toolbar match the marker flags drawn on the canvas.
function markerColorCss(packed: number): string {
  const r = packed & 0xff, g = (packed >> 8) & 0xff, b = (packed >> 16) & 0xff;
  return `#${(0x1000000 | (r << 16) | (g << 8) | b).toString(16).slice(1)}`;
}
// Blend a packed color 50% toward the waveform bg (rgb 27/29/33 = the
// 0.106/0.114/0.129 the digital shader composites against), keeping alpha.
// Used to fade value-label text on eye-dimmed rows so the text dims with the
// waveform (the shader handles the pill itself).
function dimToBg(packed: number): number {
  const r = packed & 0xff, g = (packed >> 8) & 0xff, b = (packed >> 16) & 0xff, a = (packed >>> 24) & 0xff;
  const mix = (c: number, bg: number) => Math.round(c + (bg - c) * 0.5);
  return packRgba(mix(r, 27), mix(g, 29), mix(b, 33), a);
}
const GRID_GRAY = packRgba(0x86, 0x8c, 0x96, 0x70);
const DEAD_ZONE_GRAY = packRgba(0x78, 0x7c, 0x86, 0x70);
const RESET_RED = packRgba(0xe8, 0x6a, 0x5a, 0x60);
const RESET_TEXT = packRgba(0xf0, 0x6b, 0x5b, 0xff); // solid, for the "RESET" label
const NOTCH_COLOR = packRgba(0x86, 0x8c, 0x96, 0xff);
const NOTCH_HEIGHT = 12;
// Bottom ruler band height (CSS px). Matches the `.status` cursor bar
// (index.html `.status { height: 24px }`), not the taller top ruler.
const BOTTOM_RULER_HEIGHT = 24;

// Pick a "nice" ruler-tick spacing — multiples of {1, 2, 5} × 10^n — so the
// visible range gets ~8 labels.
function rulerSpacing(visibleTicks: number): number {
  const target = visibleTicks / 8;
  const exp = Math.floor(Math.log10(target));
  const base = Math.pow(10, exp);
  const m = target / base;
  if (m < 2) return base;
  if (m < 5) return 2 * base;
  return 5 * base;
}

function dynamicRulerTicks(startTicks: number, visibleTicks: number): { ticks: number[]; labels: string[] } {
  const spacing = rulerSpacing(visibleTicks);
  const first = Math.ceil(startTicks / spacing) * spacing;
  const ticks: number[] = [];
  const labels: string[] = [];
  // Tolerance avoids dropping ticks at the right edge due to fp accumulation.
  const end = startTicks + visibleTicks + spacing * 1e-6;
  for (let t = first; t <= end; t += spacing) {
    ticks.push(t);
    labels.push(formatRulerLabel(t, spacing));
  }
  return { ticks, labels };
}

function formatRulerLabel(t: number, spacing: number): string {
  const decimals = spacing >= 1 ? 0 : Math.max(0, -Math.floor(Math.log10(spacing)));
  return `${t.toFixed(decimals)} ns`;
}

// Clock period in ticks (full cycle = two half-period segments). Cycle `c`'s
// rising edge lands at tick `MOCK_CLOCK_TICK_NS + (c-1)*PERIOD` (5, 15, 25…),
// matching `CLOCK_EDGE_TICKS`.
const CLOCK_PERIOD_NS = 2 * MOCK_CLOCK_TICK_NS;

// Count clock rising edges in the open-low/closed-high span (a, b] — i.e. the
// number of rising edges crossed moving from one tick to the other. Rising
// edges sit at `MOCK_CLOCK_TICK_NS + k*PERIOD`, k ≥ 0.
function clockEdgesBetween(a: number, b: number): number {
  const lo = Math.min(a, b);
  const hi = Math.max(a, b);
  const eps = CLOCK_PERIOD_NS * 1e-6;
  const kHi = Math.floor((hi - MOCK_CLOCK_TICK_NS + eps) / CLOCK_PERIOD_NS);
  const kLo = Math.floor((lo - MOCK_CLOCK_TICK_NS + eps) / CLOCK_PERIOD_NS);
  const kStart = Math.max(kLo + 1, 0);
  return Math.max(0, kHi - kStart + 1);
}

// The integer cycle index a tick sits in (the most recent rising edge). Cycle 1's
// rising edge is at MOCK_CLOCK_TICK_NS.
function clockCycleOf(tick: number): number {
  const eps = CLOCK_PERIOD_NS * 1e-6;
  return Math.floor((tick - MOCK_CLOCK_TICK_NS + eps) / CLOCK_PERIOD_NS) + 1;
}
// Inverse used on edit commit: snap a typed cycle count to a rounded tick —
// `cycle period × cycle count`. Loses sub-cycle precision by design.
function clockCycleToTick(cycle: number): number {
  return cycle * CLOCK_PERIOD_NS;
}
// Cursor/marker readout in clock mode, e.g. `#3`.
function formatClockWhole(tick: number): string {
  return `#${clockCycleOf(tick)}`;
}

// Clock-anchored ruler: ticks land on clock rising edges, labels count cycles
// ("1", "2", …) instead of ns. Spacing snaps to a "nice" whole number of cycles.
function clockRulerTicks(startTicks: number, visibleTicks: number): { ticks: number[]; labels: string[] } {
  const edge0 = MOCK_CLOCK_TICK_NS;
  const visibleCycles = visibleTicks / CLOCK_PERIOD_NS;
  const cycleStep = Math.max(1, Math.round(rulerSpacing(visibleCycles)));
  const startCycle = (startTicks - edge0) / CLOCK_PERIOD_NS + 1;
  let c = Math.max(cycleStep, Math.ceil(startCycle / cycleStep) * cycleStep);
  const ticks: number[] = [];
  const labels: string[] = [];
  const end = startTicks + visibleTicks + CLOCK_PERIOD_NS * 1e-6;
  for (; ; c += cycleStep) {
    const t = edge0 + (c - 1) * CLOCK_PERIOD_NS;
    if (t > end) break;
    ticks.push(t);
    labels.push(`#${c}`);
  }
  return { ticks, labels };
}

// Verilog-style timescale label: `<time unit> / <time precision>`. Precision is
// optional (VCD/FST may omit it) — fall back to just the time unit.
function formatTimescale(ts: Timescale): string {
  const unit = `${ts.value} ${ts.unit}`;
  return ts.precision ? `${unit} / ${ts.precision.value} ${ts.precision.unit}` : unit;
}

const TIME_UNIT_EXP: Record<TimeUnit, number> = { s: 0, ms: -3, us: -6, ns: -9, ps: -12, fs: -15 };
// Fractional digits the time unit needs to express one precision step. Verilog
// precision is restricted to 1/10/100 of a unit, so this stays exact.
function timeDecimals(ts: Timescale): number {
  if (!ts.precision) return 0;
  const exp = TIME_UNIT_EXP[ts.precision.unit] - TIME_UNIT_EXP[ts.unit];
  return Math.max(0, -exp - (String(ts.precision.value).length - 1));
}
// Every time readout (cursor, markers, range, hover, deltas) zero-pads to the
// file's time precision so values share one decimal width.
const TIME_DECIMALS = timeDecimals(SCENE.hierarchy.timescale);
const formatTime = (tick: number): string => tick.toFixed(TIME_DECIMALS);

function snapToClockEdge(tick: number): number {
  // Quantize to the clock period: rising edges land on odd multiples of
  // MOCK_CLOCK_TICK_NS (5, 15, 25, ...). Round to the nearest one.
  const period = 2 * MOCK_CLOCK_TICK_NS;
  return Math.round((tick - MOCK_CLOCK_TICK_NS) / period) * period + MOCK_CLOCK_TICK_NS;
}

// Clock positive-edge ticks: `buildClockSegments` emits alternating half-period
// segments starting low, so the 0→1 transitions land at ticks 5, 15, 25, ...
const CLOCK_EDGE_TICKS: number[] = [];
for (let t = MOCK_CLOCK_TICK_NS; t < MOCK_END_TICKS; t += 2 * MOCK_CLOCK_TICK_NS) {
  CLOCK_EDGE_TICKS.push(t);
}
// Single delegated tooltip for every [data-tip] element. Rendered through a
// portal at <body> so it escapes overflow/scroll ancestors and the WebGPU
// canvas. Anchors to the hovered element's top-center; CSS lifts it above.
function GlobalTooltip() {
  // Kept mounted so opacity can transition on both enter and exit; `show`
  // drives the fade, `tip` holds the last text/position (frozen during fade-out).
  const [tip, setTip] = useState<{ text: string; x: number; y: number }>({ text: "", x: 0, y: 0 });
  const [show, setShow] = useState(false);
  const [left, setLeft] = useState(0);
  const ref = useRef<HTMLDivElement>(null);
  // Clamp the (centered) tooltip so it never spills off either screen edge —
  // matters for buttons at the far left/right (e.g. the collapsed-tree expand).
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const halfW = el.offsetWidth / 2;
    const m = 4;
    const min = halfW + m;
    const max = window.innerWidth - halfW - m;
    setLeft(max < min ? min : Math.max(min, Math.min(max, tip.x)));
  }, [tip.x, tip.text]);
  useEffect(() => {
    let current: HTMLElement | null = null;
    // Watches `current`'s data-tip so a button that flips its tip on click
    // (e.g. a toggle) updates the open tooltip without the cursor leaving.
    const attrObs = new MutationObserver(() => {
      if (!current) return;
      const text = current.getAttribute("data-tip") ?? "";
      if (text === "") { setShow(false); return; }
      // Position is unchanged (element didn't move) — only refresh the text.
      setTip((p) => ({ ...p, text }));
      setShow(true);
    });
    const watch = (el: HTMLElement | null) => {
      attrObs.disconnect();
      if (el) attrObs.observe(el, { attributes: true, attributeFilter: ["data-tip"] });
    };
    const onOver = (e: MouseEvent) => {
      const el = (e.target as HTMLElement | null)?.closest("[data-tip]") as HTMLElement | null;
      if (el === current) return;
      current = el;
      watch(el);
      const text = el?.getAttribute("data-tip") ?? "";
      if (!el || text === "") { setShow(false); return; }
      const r = el.getBoundingClientRect();
      setTip({ text, x: r.left + r.width / 2, y: r.top });
      setShow(true);
    };
    const onOut = (e: MouseEvent) => {
      const to = e.relatedTarget as Node | null;
      if (current && (!to || !current.contains(to))) {
        current = null;
        watch(null);
        setShow(false);
      }
    };
    document.addEventListener("mouseover", onOver);
    document.addEventListener("mouseout", onOut);
    return () => {
      document.removeEventListener("mouseover", onOver);
      document.removeEventListener("mouseout", onOut);
      attrObs.disconnect();
    };
  }, []);
  return createPortal(
    <div ref={ref} className={`tip-pop${show ? " show" : ""}`} style={{ left, top: tip.y }}>{tip.text}</div>,
    document.body,
  );
}

// Mock menubar dropdowns. Items are representative only — clicking just closes
// the menu (no wired actions yet).
type MenuItem = { label: string; kbd?: string } | "sep";
const MENUS: { name: string; items: MenuItem[] }[] = [
  {
    name: "File", items: [
      { label: "New Window", kbd: "⌘N" },
      { label: "Open VCD…", kbd: "⌘O" },
      { label: "Open Recent" },
      "sep",
      { label: "Reload Trace", kbd: "⌘R" },
      { label: "Export Image…" },
      "sep",
      { label: "Close Window", kbd: "⌘W" },
    ]
  },
  {
    name: "Edit", items: [
      { label: "Undo", kbd: "⌘Z" },
      { label: "Redo", kbd: "⇧⌘Z" },
      "sep",
      { label: "Cut", kbd: "⌘X" },
      { label: "Copy", kbd: "⌘C" },
      { label: "Paste", kbd: "⌘V" },
      "sep",
      { label: "Find…", kbd: "⌘F" },
    ]
  },
  {
    name: "View", items: [
      { label: "Zoom In", kbd: "⌘+" },
      { label: "Zoom Out", kbd: "⌘−" },
      { label: "Zoom to Fit", kbd: "⌘0" },
      "sep",
      { label: "Toggle Signal Tree" },
      { label: "Toggle Active Signals" },
      "sep",
      { label: "Reset Layout" },
    ]
  },
  {
    name: "Signals", items: [
      { label: "Add Signal…", kbd: "⌘⏎" },
      { label: "Group Selected" },
      { label: "Remove from View" },
      "sep",
      { label: "Set Radix" },
      { label: "Change Color…" },
    ]
  },
  {
    name: "Markers", items: [
      { label: "Add Marker", kbd: "M" },
      { label: "Delete Marker", kbd: "⌫" },
      { label: "Clear All Markers" },
      "sep",
      { label: "Next Marker", kbd: "]" },
      { label: "Previous Marker", kbd: "[" },
    ]
  },
  {
    name: "Window", items: [
      { label: "Minimize", kbd: "⌘M" },
      { label: "Zoom" },
      "sep",
      { label: "Bring All to Front" },
    ]
  },
  {
    name: "Help", items: [
      { label: "Documentation" },
      { label: "Keyboard Shortcuts", kbd: "⌘/" },
      "sep",
      { label: "About Riptide" },
    ]
  },
];

function MenuBar() {
  const [open, setOpen] = useState<{ name: string; rect: DOMRect } | null>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as HTMLElement;
      if (!t.closest(".menubar") && !t.closest(".menu-pop")) setOpen(null);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(null); };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const pick = (name: string, el: HTMLElement) => setOpen({ name, rect: el.getBoundingClientRect() });
  // Frozen snapshot of the currently/last-open menu. Stays mounted while `open`
  // is null so the popup can fade out (the `show` class drives the opacity).
  const [pop, setPop] = useState<{ rect: DOMRect; items: MenuItem[] } | null>(null);
  useEffect(() => {
    if (!open) return;
    const menu = MENUS.find((m) => m.name === open.name);
    if (menu) setPop({ rect: open.rect, items: menu.items });
  }, [open]);
  return (
    <div className="menubar">
      {MENUS.map((m) => (
        <span
          key={m.name}
          className={`m${open?.name === m.name ? " open" : ""}`}
          onClick={(e) => {
            // Capture the rect synchronously — e.currentTarget is nulled before
            // a functional setState updater would run, which would crash.
            const rect = e.currentTarget.getBoundingClientRect();
            setOpen((o) => (o?.name === m.name ? null : { name: m.name, rect }));
          }}
          onMouseEnter={(e) => { if (open) pick(m.name, e.currentTarget); }}
        >{m.name}</span>
      ))}
      {createPortal(
        <div
          className={`menu-pop${open ? " show" : ""}`}
          style={{ left: pop?.rect.left ?? 0, top: (pop?.rect.bottom ?? 0) + 4 }}
        >
          {(pop?.items ?? []).map((it, i) => it === "sep"
            ? <div key={i} className="menu-sep" />
            : (
              <div key={i} className="menu-item" onClick={() => setOpen(null)}>
                <span>{it.label}</span>
                {it.kbd && <span className="menu-kbd">{it.kbd}</span>}
              </div>
            ))}
        </div>,
        document.body,
      )}
    </div>
  );
}

// Mock right-click menu for active-signal rows. Visual-only, items just close.
const ACTIVE_SIGNAL_MENU: MenuItem[] = [
  { label: "Change Color…" },
  { label: "Set Radix" },
  { label: "Rename…" },
  "sep",
  { label: "Group with Selected" },
  { label: "Insert Divider" },
  "sep",
  { label: "Move to Top" },
  { label: "Move to Bottom" },
  "sep",
  { label: "Remove from View", kbd: "⌫" },
];

function ContextMenu({ x, y, items, onClose }: { x: number; y: number; items: MenuItem[]; onClose: () => void }) {
  // Mount hidden, then flip `show` next frame so the opacity transition runs
  // (the `.menu-pop` base style is now opacity:0 / pointer-events:none).
  const [show, setShow] = useState(false);
  useEffect(() => {
    const r = requestAnimationFrame(() => setShow(true));
    return () => cancelAnimationFrame(r);
  }, []);
  useEffect(() => {
    const onDown = (e: MouseEvent) => { if (!(e.target as HTMLElement).closest(".menu-pop")) onClose(); };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    window.addEventListener("blur", onClose);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("blur", onClose);
    };
  }, [onClose]);
  return createPortal(
    <div className={`menu-pop${show ? " show" : ""}`} style={{ left: x, top: y }}>
      {items.map((it, i) => it === "sep"
        ? <div key={i} className="menu-sep" />
        : (
          <div key={i} className="menu-item" onClick={onClose}>
            <span>{it.label}</span>
            {it.kbd && <span className="menu-kbd">{it.kbd}</span>}
          </div>
        ))}
    </div>,
    document.body,
  );
}

// Inline click-to-edit number for the range label. Renders as plain text until
// clicked, then swaps to a content-sized <input> in the same spot (no new
// chrome). Enter/blur commits via onCommit; Esc cancels; a rejected commit
// flashes a red border and keeps editing.
function EditableNum({ value, onCommit, format, editValue }: {
  value: number;
  onCommit: (n: number) => boolean;
  format: (n: number) => string;
  // The number to seed the edit field with, if it differs from the displayed
  // value (e.g. clock mode shows the cycle index but edits in cycle units).
  editValue?: number;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [err, setErr] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing) { inputRef.current?.focus(); inputRef.current?.select(); }
  }, [editing]);

  if (!editing) {
    return (
      <span
        className="num-edit"
        onClick={() => { setDraft(String(editValue ?? value)); setErr(false); setEditing(true); }}
      >{format(value)}</span>
    );
  }
  const tryCommit = () => onCommit(parseFloat(draft));
  return (
    <input
      ref={inputRef}
      className={`num-input${err ? " err" : ""}`}
      value={draft}
      style={{ width: `${Math.max(2, draft.length + 1)}ch` }}
      onChange={(e) => { setDraft(e.target.value); setErr(false); }}
      onKeyDown={(e) => {
        if (e.key === "Enter") { if (tryCommit()) setEditing(false); else setErr(true); }
        else if (e.key === "Escape") setEditing(false);
      }}
      onBlur={() => { tryCommit(); setEditing(false); }}
    />
  );
}

export function App() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const signalsRef = useRef<HTMLDivElement>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const gpuRef = useRef<{ device: GPUDevice; colorBuf: GPUBuffer } | null>(null);
  const textColorByRowRef = useRef<Map<number, number>>(new Map());

  // Viewport state — refs only (RAF is the sole reader, no React DOM uses
  // these). `userInteractedRef` flips on first interaction, freezing auto-fit.
  const startTicksRef = useRef(0);
  const ticksPerPixelRef = useRef(0); // initialized to fit on first frame
  // One-shot: seed the viewport from the persisted window on the first frame
  // (once timelinePx is known) instead of auto-fitting.
  const viewportSeededRef = useRef(false);
  // Button-driven zoom (in/out/fit) eases the viewport toward a target over
  // ZOOM_ANIM_MS. The rAF loop advances it; wheel zoom clears it (stays instant).
  // releaseFit re-enables auto-fit once a "fit" animation lands.
  const zoomAnimRef = useRef<{
    tpp0: number; start0: number; tppT: number; startT: number; t0: number; releaseFit: boolean;
  } | null>(null);
  const userInteractedRef = useRef(false);
  const draggingRef = useRef(false);

  const [activeSignals, setActiveSignals] = useState<ActiveSignalRef[]>(SCENE.activeSignals);
  const [picker, setPicker] = useState<{ row: number; anchorRect: DOMRect } | null>(null);
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number } | null>(null);
  const [snapCursor, setSnapCursor] = useState(INITIAL.toggles.snapCursor);
  const [clockAnchor, setClockAnchor] = useState(INITIAL.toggles.clockAnchor);
  // Cursor needs both a ref (event handlers, frame loop) and state (active-
  // signal value column re-renders on cursor move).
  const [cursorTicks, setCursorTicks] = useState(INITIAL.time.cursor);
  const cursorTicksRef = useRef(INITIAL.time.cursor);
  // Live pointer readout for the status bar: the unsnapped tick under the
  // pointer and the signal row it's over (null when off the wave area). Drives
  // a per-move single-point value query, independent of the selected cursor.
  const [hover, setHover] = useState<{ tick: number; row: number } | null>(null);
  // Ref drives the rAF guide line; written synchronously in the pointer handler
  // (not synced from `hover` state) so the line tracks the pointer with no
  // React-commit lag. `hover` state only feeds the status-bar text.
  const hoverRef = useRef<{ tick: number; row: number } | null>(null);
  // Reactive mirror of the visible [start, end] tick window, synced from the
  // RAF loop. Drives the editable range label; edits write it back via refs.
  const [viewRange, setViewRange] = useState({ start: INITIAL.time.start, end: INITIAL.time.end });
  const viewReportedRef = useRef({ start: -1, end: -1 });
  // Fresh ref mirror of viewRange — the auto-save snapshot reads it without
  // viewRange being a save trigger (RAF updates it per frame during interaction).
  const viewRangeRef = useRef(viewRange);
  useEffect(() => { viewRangeRef.current = viewRange; }, [viewRange]);
  // Open VCD tabs (mock — no real file loading yet).
  const [openFiles, setOpenFiles] = useState(INITIAL.tabs.open);
  const [activeTab, setActiveTab] = useState(INITIAL.tabs.active);
  const snapCursorRef = useRef(snapCursor);
  useEffect(() => { snapCursorRef.current = snapCursor; }, [snapCursor]);

  // Markers — both state (status bar, toolbar) and refs (RAF loop, pointer
  // handlers). markerSeqRef issues monotonic ids/names so deletes never reuse a
  // name. Initialized from the sidecar (empty for a fresh trace).
  const [markers, setMarkers] = useState<Marker[]>(INITIAL_MARKERS);
  const markersRef = useRef(markers);
  useEffect(() => { markersRef.current = markers; }, [markers]);
  const markerSeqRef = useRef(INITIAL_MARKER_SEQ);
  const [selectedMarkerId, setSelectedMarkerId] = useState<number | null>(INITIAL_SELECTED_MARKER);
  const selectedMarkerIdRef = useRef<number | null>(INITIAL_SELECTED_MARKER);
  useEffect(() => { selectedMarkerIdRef.current = selectedMarkerId; }, [selectedMarkerId]);
  // Per-frame marker hit boxes (CSS px) + ruler height, for pointer grabbing.
  const markerHitsRef = useRef<{ id: number; x0: number; x1: number; lineX: number }[]>([]);
  const rulerHeightRef = useRef(0);
  const draggingMarkerRef = useRef<number | null>(null);

  // Signal-tree expansion lives here (lifted from SignalTreeView) so it can be
  // persisted to the sidecar.
  const [expandedScopes, setExpandedScopes] = useState<Set<NodeId>>(SCENE.initialExpanded);
  const toggleScope = (id: NodeId) =>
    setExpandedScopes((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  // Bumped on viewport-settle (pan end / wheel / zoom-anim end) to trigger one
  // sidecar write of the final viewport — viewRange itself is not a save dep
  // (the RAF loop updates it per frame during interaction).
  const [viewSaveNonce, setViewSaveNonce] = useState(0);
  const bumpViewSave = () => setViewSaveNonce((n) => n + 1);

  const addMarkerAtCursor = () => {
    const seq = markerSeqRef.current++;
    const color = MARKER_PALETTE[(seq - 1) % MARKER_PALETTE.length];
    setMarkers((ms) => [...ms, { id: seq, name: `M${seq}`, tick: cursorTicksRef.current, color }]);
    setSelectedMarkerId(seq);
  };
  // Delete the selected marker; if none selected, clear all.
  const clearMarkers = () => {
    const sel = selectedMarkerIdRef.current;
    if (sel != null && markersRef.current.some((m) => m.id === sel)) {
      setMarkers((ms) => ms.filter((m) => m.id !== sel));
    } else {
      setMarkers([]);
    }
    setSelectedMarkerId(null);
  };
  const deleteMarker = (id: number) => {
    setMarkers((ms) => ms.filter((m) => m.id !== id));
    setSelectedMarkerId((sel) => (sel === id ? null : sel));
  };
  const selectedRowRef = useRef(SCENE.activeSignals.find((r) => r.selected)?.row ?? -1);
  // Bitmask of rows whose eye is toggled off (row i → bit i). Read per-frame and
  // packed into the viewport uniform; the digital shader dims those rows to 50%.
  const dimMaskRef = useRef(0);
  // Mirror the clock-anchor toggle into a ref so the rAF frame loop can read it
  // without re-subscribing. On → ruler counts clock cycles instead of ns.
  const clockAnchorRef = useRef(clockAnchor);
  useEffect(() => { clockAnchorRef.current = clockAnchor; }, [clockAnchor]);
  useEffect(() => {
    selectedRowRef.current = activeSignals.find((r) => r.selected)?.row ?? -1;
    let mask = 0;
    for (const r of activeSignals) if (r.hidden && r.row < 32) mask |= 1 << r.row;
    dimMaskRef.current = mask >>> 0;
  }, [activeSignals]);

  // Keyboard: `m` drops a marker at the cursor, Delete/Backspace removes the
  // selected one. Ignore while typing in an input. Handlers read refs, so the
  // once-bound closures stay correct without re-subscribing.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable)) return;
      if (e.key === "m" || e.key === "M") {
        addMarkerAtCursor();
      } else if (e.key === "Delete" || e.key === "Backspace") {
        const sel = selectedMarkerIdRef.current;
        if (sel == null) return;
        setMarkers((ms) => ms.filter((m) => m.id !== sel));
        setSelectedMarkerId(null);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    const signals = signalsRef.current;
    if (!canvas || !signals) return;

    let raf = 0;

    initGPU(canvas).then(async ({ device, ctx, format }) => {
      const gpuCtx = { device, ctx, format };
      const colorBuf = createColorBuffer(device);
      writeRowColors(device, colorBuf, SCENE.activeSignals);
      gpuRef.current = { device, colorBuf };
      const renderer = createDigitalRenderer(gpuCtx);
      const native = NATIVE;
      const scene = renderer.createSceneBuffers(native.rowInfo, native.x0Pool, native.x1Pool);
      const [multiBit, singleBit, textRenderer, lineRenderer, rectRenderer] = await Promise.all([
        renderer.buildPipelineFromPacked("multi", native.multi, native.multiCount, colorBuf, scene),
        renderer.buildPipelineFromPacked("single", native.single, native.singleCount, colorBuf, scene),
        createTextRenderer(gpuCtx, renderer.uniformBuf),
        createLineRenderer(gpuCtx, renderer.uniformBuf),
        createRectRenderer(gpuCtx, renderer.uniformBuf),
      ]);
      const linesBg = lineRenderer.createBatch();
      const linesFg = lineRenderer.createBatch();
      const rectsBg = rectRenderer.createBatch();
      const textBody = textRenderer.createBatch();
      // One rect+text batch per overlay pill so opaque rects can fully occlude
      // earlier pills' text (no z buffer needed). A fixed pool of marker pills
      // (reused across frames; unused ones draw nothing), then the cursor pill
      // last so it wins on overlap. allPills is built once to avoid per-frame
      // allocation; the cursor is always the final entry.
      const markerPills = Array.from({ length: MAX_MARKERS }, () => ({
        rects: rectRenderer.createBatch(),
        text: textRenderer.createBatch(),
      }));
      const pillCursor = { rects: rectRenderer.createBatch(), text: textRenderer.createBatch() };
      const allPills = [...markerPills, pillCursor];

      // Pooled scratch arrays + spec objects. Reused across frames; never
      // shrunk so JS engines can keep the underlying objects hot.
      type RectMut = { x: number; y: number; w: number; h: number; color: number; crosshatch?: boolean; rounded?: boolean; caret?: boolean; caretRight?: boolean; squareBottomLeft?: boolean; squareBottomRight?: boolean };
      type LineMut = { x: number; color: number; dashed?: boolean; fullHeight?: boolean };
      const rectsBgScratch: RectMut[] = [];
      const linesBgScratch: LineMut[] = [];
      const linesFgScratch: LineMut[] = [];
      const pillRectScratch: RectMut[] = [];
      const getRect = (arr: RectMut[], i: number): RectMut => {
        let r = arr[i];
        if (!r) { r = { x: 0, y: 0, w: 0, h: 0, color: 0 }; arr[i] = r; }
        r.crosshatch = undefined;
        r.rounded = undefined;
        r.caret = undefined;
        r.caretRight = undefined;
        r.squareBottomLeft = undefined;
        r.squareBottomRight = undefined;
        return r;
      };
      const getLine = (arr: LineMut[], i: number): LineMut => {
        let l = arr[i];
        if (!l) { l = { x: 0, color: 0 }; arr[i] = l; }
        l.dashed = undefined;
        l.fullHeight = undefined;
        return l;
      };

      // Hoisted viewport object — mutated in place each frame.
      const vp = {
        ticks_per_pixel: 0,
        start_ticks: 0,
        width: 0,
        height: 0,
        row_height: 0,
        dpr: 1,
        selected_row: -1,
        wave_y_offset: 0,
        dim_mask: 0,
      };

      // Cache layout-derived measurements so the rAF loop never calls
      // getBoundingClientRect (which forces sync reflow). ResizeObserver
      // refreshes them on size change; matchMedia handles DPR-only changes.
      const cached = { canvasW: canvas.clientWidth, canvasH: canvas.clientHeight, rowH: 22 };
      const updateMetrics = () => {
        cached.canvasW = canvas.clientWidth;
        cached.canvasH = canvas.clientHeight;
        const fr = signals.firstElementChild as HTMLElement | null;
        if (fr) cached.rowH = fr.getBoundingClientRect().height;
      };

      const writeText = (
        batch: typeof textBody,
        startGlyph: number,
        x: number,
        y: number,
        text: string,
        color: number,
        small = false,
      ) => {
        const cell = small ? textRenderer.cellSm : textRenderer.cellLg;
        let gi = startGlyph;
        for (let k = 0; k < text.length && gi < MAX_GLYPHS; k++) {
          const code = text.charCodeAt(k);
          if ((code < 0x20 || code > 0x7e) && code !== ATLAS_MIDDLE_DOT) continue;
          batch.writeGlyph(gi++, x + k * cell.widthPx, y, code, color, small);
        }
        return gi;
      };

      const ro = new ResizeObserver(() => { resizeCanvas(canvas); updateMetrics(); });
      ro.observe(canvas);
      ro.observe(signals);
      resizeCanvas(canvas);
      updateMetrics();

      // DPR-only changes (e.g. dragging the window between displays at
      // different scales) don't trigger ResizeObserver because clientWidth
      // stays the same. Watch for them via matchMedia and re-arm each fire.
      let dprMql: MediaQueryList = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
      const onDprChange = () => {
        resizeCanvas(canvas);
        updateMetrics();
        dprMql.removeEventListener("change", onDprChange);
        dprMql = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
        dprMql.addEventListener("change", onDprChange);
      };
      dprMql.addEventListener("change", onDprChange);

      const frame = (now: number) => {
        // All measurements are in CSS pixels (cached, refreshed by
        // ResizeObserver). Multiply by DPR to get physical canvas pixels —
        // the only unit the GPU shader knows about.
        const dpr = window.devicePixelRatio || 1;
        const canvasW = cached.canvasW;
        const canvasH = cached.canvasH;
        const rowHeightCSS = cached.rowH;
        const rulerHeightCSS = rowHeightCSS;
        rulerHeightRef.current = rulerHeightCSS;
        const waveHeightCSS = Math.max(0, canvasH - rulerHeightCSS);

        const timelinePx = canvasW;
        if (timelinePx <= 0) { raf = requestAnimationFrame(frame); return; }

        // Seed the persisted viewport once, now that we know the canvas width.
        // A full-range window is left to auto-fit (so it keeps re-fitting on
        // resize); any other saved window is treated as an explicit zoom and
        // freezes auto-fit, mirroring a user interaction.
        if (!viewportSeededRef.current) {
          viewportSeededRef.current = true;
          const span = INITIAL.time.end - INITIAL.time.start;
          const isFullRange =
            Math.abs(INITIAL.time.start) < 1e-6 && Math.abs(INITIAL.time.end - MOCK_END_TICKS) < 1e-6;
          if (span > 0 && !isFullRange) {
            ticksPerPixelRef.current = span / timelinePx;
            startTicksRef.current = INITIAL.time.start;
            userInteractedRef.current = true;
          }
        }

        // Auto-fit until the user interacts, then freeze.
        if (!userInteractedRef.current || ticksPerPixelRef.current <= 0) {
          ticksPerPixelRef.current = MOCK_END_TICKS / timelinePx;
          startTicksRef.current = 0;
        }
        // Advance a button-driven zoom animation. tpp eases geometrically
        // (constant-ratio zoom feels uniform); start eases linearly.
        const anim = zoomAnimRef.current;
        if (anim) {
          const e = easeOutCubic(Math.min(1, (now - anim.t0) / ZOOM_ANIM_MS));
          ticksPerPixelRef.current = anim.tpp0 * Math.pow(anim.tppT / anim.tpp0, e);
          startTicksRef.current = anim.start0 + (anim.startT - anim.start0) * e;
          if (e >= 1) {
            if (anim.releaseFit) userInteractedRef.current = false;
            zoomAnimRef.current = null;
            bumpViewSave(); // zoom/fit animation landed — persist final window
          }
        }
        const ticksPerPixel = ticksPerPixelRef.current;
        const startTicks = startTicksRef.current;
        const visibleTicks = timelinePx * ticksPerPixel;
        // Report the visible window to React (throttled) for the range label.
        const viewEnd = startTicks + visibleTicks;
        const rep = viewReportedRef.current;
        if (Math.abs(rep.start - startTicks) > 1e-6 || Math.abs(rep.end - viewEnd) > 1e-6) {
          rep.start = startTicks; rep.end = viewEnd;
          setViewRange({ start: startTicks, end: viewEnd });
        }
        const cursor = cursorTicksRef.current;
        const xForTick = (tick: number) => (tick - startTicks) / ticksPerPixel;
        vp.ticks_per_pixel = ticksPerPixel;
        vp.start_ticks = startTicks;
        vp.width = canvasW;
        vp.height = canvasH;
        vp.row_height = rowHeightCSS;
        vp.dpr = dpr;
        vp.selected_row = selectedRowRef.current;
        vp.wave_y_offset = rulerHeightCSS;
        const dimMask = dimMaskRef.current;
        vp.dim_mask = dimMask;

        // Right-edge dead zone: extend leftward to the data end when the
        // user has zoomed out past MOCK_END_TICKS, so the OOB area shows
        // crosshatch.
        const dataEndPx = xForTick(MOCK_END_TICKS);
        const deadStartPx = Math.min(timelinePx, dataEndPx);

        // Major notch: bottom-aligned to the ruler's lower border.
        const notchY = rulerHeightCSS - NOTCH_HEIGHT;
        // Second ruler mirrored at the bottom of the canvas (ticks + labels
        // only — no flags). Its notches hang down from its top border.
        const bottomRulerH = BOTTOM_RULER_HEIGHT;
        const bottomRulerTop = canvasH - bottomRulerH;
        const { ticks: rulerTicks, labels: rulerLabels } = clockAnchorRef.current
          ? clockRulerTicks(startTicks, visibleTicks)
          : dynamicRulerTicks(startTicks, visibleTicks);
        // Labels for the bottom-ruler span arrows (marker↔cursor, reset),
        // collected while building the arrow rects and emitted in the text pass.
        const rulerArrowLabels: { x: number; y: number; text: string; color: number }[] = [];
        let bgRectN = 0;
        {
          const r0 = getRect(rectsBgScratch, bgRectN++);
          r0.x = 0; r0.y = 0; r0.w = canvasW; r0.h = rulerHeightCSS; r0.color = PANEL_2;
          const r1 = getRect(rectsBgScratch, bgRectN++);
          r1.x = 0; r1.y = rulerHeightCSS - 1; r1.w = canvasW; r1.h = 1; r1.color = BORDER;
          for (const t of rulerTicks) {
            const r = getRect(rectsBgScratch, bgRectN++);
            // Center the 2px notch on the tick — waveform edges & dashed grid
            // lines are centered on xForTick(t), so a left-anchored rect lands
            // ~1px right of the real edge.
            r.x = xForTick(t) - 1; r.y = notchY; r.w = 2; r.h = NOTCH_HEIGHT; r.color = NOTCH_COLOR;
          }
          const rd = getRect(rectsBgScratch, bgRectN++);
          rd.x = deadStartPx; rd.y = rulerHeightCSS;
          rd.w = canvasW - deadStartPx; rd.h = waveHeightCSS;
          rd.color = DEAD_ZONE_GRAY; rd.crosshatch = true;
          // Bottom ruler band + top border + notches (drawn after the dead
          // zone so its opaque fill covers any crosshatch beneath it).
          const br0 = getRect(rectsBgScratch, bgRectN++);
          br0.x = 0; br0.y = bottomRulerTop; br0.w = canvasW; br0.h = bottomRulerH; br0.color = PANEL_2;
          const br1 = getRect(rectsBgScratch, bgRectN++);
          br1.x = 0; br1.y = bottomRulerTop; br1.w = canvasW; br1.h = 1; br1.color = BORDER;
          for (const t of rulerTicks) {
            const r = getRect(rectsBgScratch, bgRectN++);
            // Tick marks sit in the bottom half, anchored to the canvas edge.
            r.x = xForTick(t) - 1; r.y = canvasH - NOTCH_HEIGHT; r.w = 2; r.h = NOTCH_HEIGHT; r.color = NOTCH_COLOR;
          }
          // Double-headed span arrow in the empty band above the notches:
          // open caret_sdf chevrons (see rect.wgsl) at each end, a shaft split
          // around a centered label (dimension-line style). Used for both the
          // marker↔cursor delta and the reset-held region.
          const arrowY = bottomRulerTop + (bottomRulerH - NOTCH_HEIGHT) * 0.5;
          const drawSpanArrow = (leftX: number, rightX: number, label: string, color: number) => {
            const headW = 12, headH = 10, shaftH = 2, gap = 6;
            const cellSm = textRenderer.cellSm;
            const textW = label.length * cellSm.widthPx;
            const labelPad = 5;
            const labelY = Math.round(arrowY - cellSm.midlinePx);
            const drawShaft = (x0: number, x1: number) => {
              if (x1 <= x0) return;
              const sh = getRect(rectsBgScratch, bgRectN++);
              sh.x = x0; sh.y = arrowY - shaftH * 0.5; sh.w = x1 - x0; sh.h = shaftH; sh.color = color;
            };
            // pointsRight = ">" (caretRight); else "<". apex sits at the rect center.
            const drawHead = (centerX: number, pointsRight: boolean) => {
              const h = getRect(rectsBgScratch, bgRectN++);
              h.x = centerX - headW * 0.5; h.y = arrowY - headH * 0.5;
              h.w = headW; h.h = headH; h.color = color; h.caret = true; h.caretRight = pointsRight;
            };
            const pushLabel = (x: number) => {
              rulerArrowLabels.push({ x: Math.round(x), y: labelY, text: label, color });
            };
            // Offset the label beside the arrow: right of xR by default, flipped
            // to the left of xL when it would overflow the canvas edge.
            const pushSideLabel = (xR: number, xL: number) => {
              const right = xR + labelPad;
              pushLabel(right + textW <= canvasW - 2 ? right : xL - labelPad - textW);
            };

            const leftApex = leftX + gap;
            const rightApex = rightX - gap;
            // insideRoom = span between the two inward-anchored apexes. Each head
            // covers headW/2 of the shaft inward from its apex, so the shaft only
            // shows (insideRoom - headW) px clear of both chevrons. Keep the
            // horizontal shaft only while ≥ 2 px of it stays clear; otherwise flip
            // to the close (carets-only) layout.
            const insideRoom = rightApex - leftApex;
            const minShaftClear = 2;

            if (insideRoom - headW >= minShaftClear) {
              // Wide: dimension-line double arrow ◄──►, heads pointing outward at
              // each apex. Label splits the shaft when it fits, else sits beside
              // the arrow (same side-offset as close mode).
              const midX = (leftApex + rightApex) * 0.5;
              const splitL = midX - textW * 0.5 - labelPad;
              const splitR = midX + textW * 0.5 + labelPad;
              const labelFits = splitL > leftApex + 2 && splitR < rightApex - 2;
              if (labelFits) {
                drawShaft(leftApex, splitL);
                drawShaft(splitR, rightApex);
                pushLabel(midX - textW * 0.5);
              } else {
                drawShaft(leftApex, rightApex);
                pushSideLabel(rightApex + headW * 0.5, leftApex - headW * 0.5);
              }
              drawHead(leftApex, false);  // "<"
              drawHead(rightApex, true);  // ">"
            } else {
              // Close together: flip the heads to the outside pointing inward
              // (> <) so they never cross — no connector line — and offset the
              // label beside the arrow.
              drawHead(leftX - gap, true);   // ">" just left of the left line
              drawHead(rightX + gap, false); // "<" just right of the right line
              pushSideLabel(rightX + gap + headW * 0.5, leftX - gap - headW * 0.5);
            }
          };

          // Reset-held region: red crosshatch over the bottom ruler band,
          // styled like the beyond-end-of-time gray crosshatch.
          {
            const rx0 = xForTick(RESET_HELD_TICKS.tStart);
            const rx1 = xForTick(RESET_HELD_TICKS.tEnd);
            const rc = getRect(rectsBgScratch, bgRectN++);
            rc.x = rx0; rc.y = bottomRulerTop; rc.w = rx1 - rx0; rc.h = bottomRulerH;
            rc.color = RESET_RED; rc.crosshatch = true;
            // "RESET" label centered in the band, if it fits.
            const cellSm = textRenderer.cellSm;
            const label = "RESET";
            const textW = label.length * cellSm.widthPx;
            if (rx1 - rx0 > textW + 4) {
              rulerArrowLabels.push({
                x: Math.round((rx0 + rx1) * 0.5 - textW * 0.5),
                y: Math.round(arrowY - cellSm.midlinePx),
                text: label,
                color: RESET_TEXT,
              });
            }
          }

          // Marker↔cursor delta — only when a marker is actually selected.
          // xForTick gives each line's center (see lines.wgsl), so the arrow
          // endpoints land on the line centers directly.
          const arrowMarker =
            markersRef.current.find((m) => m.id === selectedMarkerIdRef.current);
          if (arrowMarker) {
            const mX = xForTick(arrowMarker.tick);
            const cX = xForTick(cursor);
            const spanLabel = clockAnchorRef.current
              ? `${clockEdgesBetween(arrowMarker.tick, cursor)} clks`
              : `${formatTime(Math.abs(cursor - arrowMarker.tick))} ns`;
            drawSpanArrow(
              Math.min(mX, cX),
              Math.max(mX, cX),
              spanLabel,
              arrowMarker.color,
            );
          }
        }
        rectsBg.setRects(rectsBgScratch, bgRectN);

        // Grid: dashed vertical lines at each visible rising clock edge.
        // Segment right edges sit just left of their tick, so the line lands
        // immediately after.
        const visStart = startTicks - 1;
        const visEnd = startTicks + visibleTicks + 1;
        let bgLineN = 0;
        for (const t of CLOCK_EDGE_TICKS) {
          if (t < visStart || t > visEnd) continue;
          const l = getLine(linesBgScratch, bgLineN++);
          l.x = xForTick(t); l.color = GRID_GRAY; l.dashed = true;
        }
        linesBg.setLines(linesBgScratch, bgLineN);

        const markers = markersRef.current;
        const selId = selectedMarkerIdRef.current;
        let fgLineN = 0;
        for (const m of markers) {
          if (fgLineN >= MAX_MARKERS) break;
          const l = getLine(linesFgScratch, fgLineN++);
          // Selected marker draws solid to stand out; others dashed.
          l.x = xForTick(m.tick); l.color = m.color; l.dashed = m.id !== selId;
        }
        // Gray dashed guide under the live pointer (not the selected cursor).
        const hov = hoverRef.current;
        if (hov && fgLineN < MAX_MARKERS) {
          const lh = getLine(linesFgScratch, fgLineN++);
          lh.x = xForTick(hov.tick); lh.color = GRID_GRAY; lh.dashed = true; lh.fullHeight = true;
        }
        const lcur = getLine(linesFgScratch, fgLineN++);
        lcur.x = xForTick(cursor); lcur.color = HOT;
        linesFg.setLines(linesFgScratch, fgLineN);

        // Build glyph instances for multi-bit pill values.
        const cellLg = textRenderer.cellLg;
        const cellW = cellLg.widthPx;
        let gi = 0;
        const rulerLabelY = Math.round(rulerHeightCSS * 0.5 + 2);
        const bottomLabelY = Math.round(bottomRulerTop + bottomRulerH * 0.5 + 2);
        for (let i = 0; i < rulerTicks.length; i++) {
          const lx = Math.round(xForTick(rulerTicks[i]) + 5);
          const label = rulerLabels[i];
          gi = writeText(textBody, gi, lx, rulerLabelY, label, TEXT_SECONDARY, true);
          gi = writeText(textBody, gi, lx, bottomLabelY, label, TEXT_SECONDARY, true);
        }
        for (const al of rulerArrowLabels) {
          gi = writeText(textBody, gi, al.x, al.y, al.text, al.color, true);
        }
        for (const lbl of MULTI_BIT_LABELS) {
          if (gi >= MAX_GLYPHS) break;
          const startPx = xForTick(lbl.tStart);
          const endPx = xForTick(lbl.tEnd);
          const widthPx = endPx - startPx;
          const textWidthPx = lbl.text.length * cellW;
          if (widthPx < textWidthPx + 6) continue; // skip if pill too narrow
          const centerX = (startPx + endPx) * 0.5;
          const x0 = Math.round(centerX - textWidthPx * 0.5);
          const y0 = Math.round(rulerHeightCSS + rowHeightCSS * (lbl.row + 0.5) - cellLg.midlinePx);
          // TODO: switch to `textColorByRowRef.current.get(lbl.row)` to use
          // the per-row contrast pick. Forced white for now. Dimmed rows (eye
          // off) fade the label toward bg to match the dimmed waveform.
          const dimmed = ((dimMask >>> lbl.row) & 1) !== 0;
          const color = dimmed ? dimToBg(TEXT_WHITE) : TEXT_WHITE;
          for (let k = 0; k < lbl.text.length && gi < MAX_GLYPHS; k++) {
            const code = lbl.text.charCodeAt(k);
            if (code < 0x20 || code > 0x7e) continue;
            textBody.writeGlyph(gi++, x0 + k * cellW, y0, code, color);
          }
        }
        textBody.setGlyphs(gi);

        const cellSm = textRenderer.cellSm;
        const padX = 5;
        const pillH = 14;
        const addFlag = (x: number, text: string, color: number, pill: { rects: typeof rectsBg; text: typeof textBody }) => {
          const pillW = text.length * cellSm.widthPx + padX * 2;
          // The line is centered on x (lines.wgsl), so anchor the pill's near
          // edge to the line's near edge — half a line width off x — so the
          // line enters the squared corner flush. Default: pill left edge on the
          // line's left edge. Near the right canvas edge, slide the pill leftward
          // so it stays on-screen — at x == canvas.right, pill's right edge on the
          // line's right edge. Linear ramp over the last `pillW` px of canvas
          // (interior is dead zone). Final clamp keeps the pill fully on-screen.
          const lineHalf = 2.5 * 0.5;
          const flipStart = canvasW - pillW;
          const t = Math.max(0, Math.min(1, (x - flipStart) / pillW));
          const anchor = x + (2 * t - 1) * lineHalf;
          const pillX = Math.max(0, Math.min(canvasW - pillW, anchor - t * pillW));
          const pillY = 0;
          const r = getRect(pillRectScratch, 0);
          // Square off the bottom corner the line attaches to (the anchored
          // edge) so the pill meets the line flush.
          const lineOnRight = t >= 0.5;
          r.x = pillX; r.y = pillY; r.w = pillW; r.h = pillH; r.color = color; r.rounded = true;
          r.squareBottomLeft = !lineOnRight;
          r.squareBottomRight = lineOnRight;
          pill.rects.setRects(pillRectScratch, 1);
          const glyphs = writeText(
            pill.text,
            0,
            Math.round(pillX + padX),
            Math.round(pillY + pillH * 0.5 - cellSm.midlinePx),
            text,
            ON_ACCENT,
            true,
          );
          pill.text.setGlyphs(glyphs);
          return { x0: pillX, x1: pillX + pillW };
        };
        // Marker flags + hit boxes. Selected marker drawn last so its pill wins
        // any overlap with the others.
        const hits = markerHitsRef.current;
        hits.length = 0;
        const ordered = selId == null ? markers : [...markers].sort((a, b) => Number(a.id === selId) - Number(b.id === selId));
        let mi = 0;
        for (const m of ordered) {
          if (mi >= markerPills.length) break;
          const lineX = xForTick(m.tick);
          const mLabel = clockAnchorRef.current ? formatClockWhole(m.tick) : `${formatTime(m.tick)} ns`;
          const box = addFlag(lineX, `${m.name} · ${mLabel}`, m.color, markerPills[mi]);
          hits.push({ id: m.id, x0: box.x0, x1: box.x1, lineX });
          mi++;
        }
        for (; mi < markerPills.length; mi++) {
          markerPills[mi].rects.setRects(pillRectScratch, 0);
          markerPills[mi].text.setGlyphs(0);
        }
        const cursorLabel = clockAnchorRef.current ? formatClockWhole(cursor) : `${formatTime(cursor)} ns`;
        addFlag(xForTick(cursor), cursorLabel, HOT, pillCursor);

        renderFrame(gpuCtx, renderer, [multiBit, singleBit], { linesBg, rectsBg, linesFg, textBody, pills: allPills }, vp);
        raf = requestAnimationFrame(frame);
      };
      raf = requestAnimationFrame(frame);

      return () => { ro.disconnect(); cancelAnimationFrame(raf); };
    }).catch((e) => {
      if (e instanceof GPUInitError) console.error("GPU init failed:", e.message);
      else throw e;
    });

    return () => cancelAnimationFrame(raf);
  }, []);

  useEffect(() => {
    const gpu = gpuRef.current;
    if (gpu) writeRowColors(gpu.device, gpu.colorBuf, activeSignals);
    const m = new Map<number, number>();
    for (const r of activeSignals) m.set(r.row, pickTextColor(r.color));
    textColorByRowRef.current = m;
  }, [activeSignals]);

  // Mouse interactivity: wheel = pan, ctrl+wheel = zoom (anchored at mouse x),
  // left click/drag = cursor follows mouse. Native listeners (not React
  // synthetic) so the wheel handler can be non-passive and call preventDefault.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const clampPan = (timelinePx: number) => {
      const visibleTicks = timelinePx * ticksPerPixelRef.current;
      if (visibleTicks < MOCK_END_TICKS) {
        startTicksRef.current = Math.max(0, Math.min(MOCK_END_TICKS - visibleTicks, startTicksRef.current));
      } else {
        // Fully zoomed out: data fits with room to spare. Force start to 0 so
        // ctrl-zoom-while-fit anchors at the data origin instead of drifting.
        startTicksRef.current = 0;
      }
    };

    // Client X → tick, clamped to canvas (pointer capture fires outside host),
    // honoring snap. Shared by cursor placement and marker dragging.
    const tickAtClientX = (clientX: number) => {
      const rect = host.getBoundingClientRect();
      const px = Math.max(0, Math.min(rect.width, clientX - rect.left));
      let tick = startTicksRef.current + px * ticksPerPixelRef.current;
      if (snapCursorRef.current) tick = snapToClockEdge(tick);
      return tick;
    };
    const setCursorAtClientX = (clientX: number) => {
      const tick = tickAtClientX(clientX);
      cursorTicksRef.current = tick;
      setCursorTicks(tick);
    };
    const moveMarker = (id: number, tick: number) => {
      setMarkers((ms) => ms.map((m) => (m.id === id ? { ...m, tick } : m)));
    };
    // Hit-test markers under the pointer: its flag pill (only in the ruler
    // band) or its line (anywhere, within slop). Returns the marker id or null.
    const markerAt = (clientX: number, clientY: number): number | null => {
      const rect = host.getBoundingClientRect();
      const px = clientX - rect.left;
      const py = clientY - rect.top;
      for (const h of markerHitsRef.current) {
        const inPill = py <= rulerHeightRef.current && px >= h.x0 && px <= h.x1;
        const onLine = Math.abs(px - h.lineX) <= MARKER_GRAB_PX;
        if (inPill || onLine) return h.id;
      }
      return null;
    };

    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      zoomAnimRef.current = null; // wheel zoom/pan is instant; drop any easing
      userInteractedRef.current = true;
      const rect = host.getBoundingClientRect();
      const timelinePx = rect.width;
      if (e.ctrlKey) {
        const mouseX = e.clientX - rect.left;
        const worldTickAtMouse = startTicksRef.current + mouseX * ticksPerPixelRef.current;
        const factor = Math.exp(e.deltaY * ZOOM_PER_DELTA_Y);
        ticksPerPixelRef.current *= factor;
        startTicksRef.current = worldTickAtMouse - mouseX * ticksPerPixelRef.current;
      } else {
        // Pan only when zoomed in past fit; otherwise ignore (clampPan would
        // snap back to 0 anyway, but skipping is cleaner UX).
        const visibleTicks = timelinePx * ticksPerPixelRef.current;
        if (visibleTicks >= MOCK_END_TICKS) return;
        const dx = e.deltaX !== 0 ? e.deltaX : e.deltaY;
        startTicksRef.current += dx * ticksPerPixelRef.current;
      }
      clampPan(timelinePx);
      bumpViewSave(); // wheel pan/zoom is instant — persist the new window
    };

    const onPointerDown = (e: PointerEvent) => {
      if (e.button !== 0) return;
      host.setPointerCapture(e.pointerId);
      // Grab a marker if one is under the pointer; else move the cursor.
      const grabbed = markerAt(e.clientX, e.clientY);
      if (grabbed != null) {
        draggingMarkerRef.current = grabbed;
        setSelectedMarkerId(grabbed);
        host.style.cursor = "col-resize";
      } else {
        draggingRef.current = true;
        setCursorAtClientX(e.clientX);
      }
    };
    // Map the pointer to (unsnapped tick, signal row) for the status readout.
    // Rows stack below the top ruler at rowHeight === rulerHeight each.
    const updateHover = (clientX: number, clientY: number) => {
      const rect = host.getBoundingClientRect();
      const rh = rulerHeightRef.current;
      const py = clientY - rect.top;
      const px = Math.max(0, Math.min(rect.width, clientX - rect.left));
      const tick = startTicksRef.current + px * ticksPerPixelRef.current;
      // row === -1 means "over the canvas but not on a signal" — the guide line
      // still draws; only the status readout needs a real row.
      let row = rh > 0 ? Math.floor(py / rh) - 1 : -1;
      if (py < rh || row < 0 || row >= SCENE.activeSignals.length) row = -1;
      // Ref drives the rAF guide line (synchronous, no React round-trip);
      // state drives the status-bar text (a commit behind is fine there).
      hoverRef.current = { tick, row };
      setHover({ tick, row });
    };
    const onPointerMove = (e: PointerEvent) => {
      updateHover(e.clientX, e.clientY);
      if (draggingMarkerRef.current != null) {
        moveMarker(draggingMarkerRef.current, tickAtClientX(e.clientX));
        return;
      }
      if (draggingRef.current) {
        setCursorAtClientX(e.clientX);
        return;
      }
      // Hover feedback: show a grab cursor when a marker is grabbable here.
      host.style.cursor = markerAt(e.clientX, e.clientY) != null ? "col-resize" : "";
    };
    const onPointerUp = (e: PointerEvent) => {
      if (draggingMarkerRef.current == null && !draggingRef.current) return;
      const wasMarker = draggingMarkerRef.current != null;
      draggingMarkerRef.current = null;
      draggingRef.current = false;
      host.releasePointerCapture(e.pointerId);
      // Settle the hover cursor at the release point (still over the line?).
      if (wasMarker) host.style.cursor = markerAt(e.clientX, e.clientY) != null ? "col-resize" : "";
    };

    host.addEventListener("wheel", onWheel, { passive: false });
    host.addEventListener("pointerdown", onPointerDown);
    host.addEventListener("pointermove", onPointerMove);
    host.addEventListener("pointerup", onPointerUp);
    host.addEventListener("pointercancel", onPointerUp);
    const onPointerLeave = () => { hoverRef.current = null; setHover(null); };
    host.addEventListener("pointerleave", onPointerLeave);
    return () => {
      host.removeEventListener("wheel", onWheel);
      host.removeEventListener("pointerdown", onPointerDown);
      host.removeEventListener("pointermove", onPointerMove);
      host.removeEventListener("pointerup", onPointerUp);
      host.removeEventListener("pointercancel", onPointerUp);
      host.removeEventListener("pointerleave", onPointerLeave);
    };
  }, []);

  const handleColorChange = (row: number, color: string) => {
    setActiveSignals((refs) => refs.map((r) => (r.row === row ? { ...r, color } : r)));
  };

  const TREE_MIN_PX = 160;
  const ACTIVE_MIN_PX = 200;
  const TREE_COLLAPSED_PX = 28;
  const TREE_DEFAULT_PX = 236;
  const ACTIVE_DEFAULT_PX = 296;
  const [treeW, setTreeW] = useState(INITIAL.panels.treeWidth);
  const [activeW, setActiveW] = useState(INITIAL.panels.activeWidth);
  const [treeCollapsed, setTreeCollapsed] = useState(INITIAL.panels.treeCollapsed);
  const [activeCollapsed, setActiveCollapsed] = useState(INITIAL.panels.activeCollapsed);
  // Manual width override for the compact strip. null = auto-hug the longest
  // name (compactW below); a number = user drag-resized. Double-click the
  // handle clears it back to the tight fit.
  const [activeCompactW, setActiveCompactW] = useState<number | null>(INITIAL.panels.activeCompactWidth);

  // ---- auto-write sidecar -------------------------------------------------
  // No debounce. Writes the full sidecar whenever persisted *discrete* state
  // changes (signals, markers, cursor, toggles, tabs, panels, tree). The
  // RAF-driven viewport (viewRange) is NOT a dep — it would write per frame
  // during pan/zoom; instead viewSaveNonce is bumped on interaction-settle to
  // persist the final window. Guards: skip the initial mount, and skip when the
  // serialized output is unchanged (no-op writes).
  const sidecarMountedRef = useRef(false);
  const lastSavedRef = useRef<string>("");
  useEffect(() => {
    const text = sidecarToString(
      serializeSidecar({
        hierarchy: SCENE.hierarchy,
        trace: { id: "keysched" },
        activeSignals,
        time: {
          start: viewRangeRef.current.start,
          end: viewRangeRef.current.end,
          cursor: cursorTicksRef.current,
        },
        markers: markers.map((m) => ({
          name: m.name, tick: m.tick, color: m.color, selected: m.id === selectedMarkerId,
        })),
        panels: {
          treeWidth: treeW,
          activeWidth: activeW,
          treeCollapsed,
          activeCollapsed,
          activeCompactWidth: activeCompactW,
        },
        treeExpanded: expandedScopes,
        toggles: { snapCursor, clockAnchor },
        tabs: { open: openFiles, active: activeTab },
      }),
    );
    if (!sidecarMountedRef.current) {
      sidecarMountedRef.current = true;
      lastSavedRef.current = text;
      return;
    }
    if (text === lastSavedRef.current) return;
    lastSavedRef.current = text;
    writeSidecarFile(sidecarPath(), text);
  }, [
    activeSignals, markers, selectedMarkerId, snapCursor, clockAnchor,
    openFiles, activeTab, treeW, activeW, treeCollapsed, activeCollapsed,
    activeCompactW, expandedScopes, cursorTicks, viewSaveNonce,
  ]);
  const treeColW = treeCollapsed ? TREE_COLLAPSED_PX : treeW;
  // Compact strip width: hug the longest signal name, but as a concrete px
  // value (not max-content) so the collapse/expand slide can animate px→px
  // like the tree panel does. Mirrors the .s-row name metrics: 12px JetBrains
  // Mono + 8px horizontal padding each side. Floored so the Name/Value header
  // stays legible when every name is short.
  const ACTIVE_COMPACT_MIN_PX = 88;
  // Recompute the measured width once the web font loads — until then canvas
  // measures with a fallback face whose metrics are narrower, which would size
  // the column too tight and truncate the longest name.
  const [fontTick, setFontTick] = useState(0);
  useEffect(() => { document.fonts?.ready.then(() => setFontTick((t) => t + 1)); }, []);
  const compactW = useMemo(() => {
    const ctx = document.createElement("canvas").getContext("2d");
    if (!ctx) return ACTIVE_COMPACT_MIN_PX;
    ctx.font = "12px 'JetBrains Mono', monospace";
    let max = 0;
    for (const ref of activeSignals) {
      const w = ctx.measureText(getSignal(SCENE.hierarchy, ref.signalId).name).width;
      if (w > max) max = w;
    }
    // The compact head still shows the "Active Signals" title + expand button,
    // so the column can't be narrower than that or it clips. Measure the title
    // (uppercase, 600, with letter-spacing) and reserve ~43px for left padding
    // + gap + the 22px button + right padding.
    ctx.font = "600 11.5px 'IBM Plex Sans', system-ui, sans-serif";
    const title = "ACTIVE SIGNALS";
    const headerW = ctx.measureText(title).width + title.length * 0.4 + 43;
    // 16 = .s-row left+right padding; +2 subpixel buffer so the last glyph of
    // the widest name never clips into an ellipsis.
    return Math.max(ACTIVE_COMPACT_MIN_PX, Math.ceil(headerW), Math.ceil(max) + 18);
  }, [activeSignals, fontTick]);
  const activeColW = activeCollapsed ? (activeCompactW ?? compactW) : activeW;
  // Enable the width transition only for the duration of a collapse/expand
  // toggle (or a double-click width reset), so live drag-resize stays instant.
  const [treeAnim, setTreeAnim] = useState(false);
  const treeAnimTimer = useRef<number | null>(null);
  // Row-content slide flag, set ONLY on a compact/full toggle — not on the
  // width pulse — so a double-click resize doesn't replay the name slide.
  // Longer than the 140ms width anim: on expand the name slides (120ms) then
  // the swatch/icon fade back in (120→240ms).
  const [rowSliding, setRowSliding] = useState(false);
  const rowSlideTimer = useRef<number | null>(null);
  // Tree-only toggle flag: gates the tree's vertical/expanded content swap so
  // it tracks the tree's own collapse, not the shared width pulse (which the
  // active-pane toggle/resize also fires).
  const [treeToggling, setTreeToggling] = useState(false);
  const treeToggleTimer = useRef<number | null>(null);
  const pulseLayoutAnim = () => {
    setTreeAnim(true);
    if (treeAnimTimer.current != null) clearTimeout(treeAnimTimer.current);
    treeAnimTimer.current = window.setTimeout(() => setTreeAnim(false), 140);
  };
  const toggleTree = (collapsed: boolean) => {
    setTreeCollapsed(collapsed);
    pulseLayoutAnim();
    setTreeToggling(true);
    if (treeToggleTimer.current != null) clearTimeout(treeToggleTimer.current);
    treeToggleTimer.current = window.setTimeout(() => setTreeToggling(false), 140);
  };
  const toggleActive = (collapsed: boolean) => {
    setActiveCollapsed(collapsed);
    pulseLayoutAnim();
    setRowSliding(true);
    if (rowSlideTimer.current != null) clearTimeout(rowSlideTimer.current);
    rowSlideTimer.current = window.setTimeout(() => setRowSliding(false), 240);
  };
  const startResize = (which: "tree" | "active" | "activeCompact") => (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    const startX = e.clientX;
    const startTree = treeW;
    const startActive = activeW;
    const startCompact = activeCompactW ?? compactW;
    const target = e.currentTarget;
    target.setPointerCapture(e.pointerId);
    target.classList.add("dragging");
    const onMove = (ev: PointerEvent) => {
      const dx = ev.clientX - startX;
      if (which === "tree") setTreeW(Math.max(TREE_MIN_PX, startTree + dx));
      else if (which === "activeCompact") setActiveCompactW(Math.max(ACTIVE_COMPACT_MIN_PX, startCompact + dx));
      else setActiveW(Math.max(ACTIVE_MIN_PX, startActive + dx));
    };
    const onUp = (ev: PointerEvent) => {
      target.releasePointerCapture(ev.pointerId);
      target.classList.remove("dragging");
      target.removeEventListener("pointermove", onMove);
      target.removeEventListener("pointerup", onUp);
      target.removeEventListener("pointercancel", onUp);
    };
    target.addEventListener("pointermove", onMove);
    target.addEventListener("pointerup", onUp);
    target.addEventListener("pointercancel", onUp);
  };

  // Click row: select it (deselecting others). Click selected row again: clear.
  const handleRowClick = (row: number) => {
    setActiveSignals((refs) => {
      const wasSelected = refs.find((r) => r.row === row)?.selected ?? false;
      return refs.map((r) => ({
        ...r,
        selected: !wasSelected && r.row === row,
      }));
    });
  };
  // Eye toggle: flip the row's cosmetic `hidden` flag. No canvas effect yet.
  const toggleSignalHidden = (row: number) => {
    setActiveSignals((refs) => refs.map((r) => (r.row === row ? { ...r, hidden: !r.hidden } : r)));
  };

  const ZOOM_STEP = 1.25;
  // Button zoom: ease toward a center-anchored target instead of snapping.
  // Reads live refs as the start so mid-animation clicks chain smoothly.
  const zoomBy = (factor: number) => {
    const host = hostRef.current;
    if (!host) return;
    const timelinePx = host.getBoundingClientRect().width;
    userInteractedRef.current = true;
    const tpp0 = ticksPerPixelRef.current > 0 ? ticksPerPixelRef.current : MOCK_END_TICKS / timelinePx;
    const start0 = startTicksRef.current;
    const centerX = timelinePx * 0.5;
    const worldTickAtCenter = start0 + centerX * tpp0;
    const tppT = tpp0 * factor;
    let startT = worldTickAtCenter - centerX * tppT;
    const visible = timelinePx * tppT;
    startT = visible < MOCK_END_TICKS ? Math.max(0, Math.min(MOCK_END_TICKS - visible, startT)) : 0;
    zoomAnimRef.current = { tpp0, start0, tppT, startT, t0: performance.now(), releaseFit: false };
  };
  const fitView = () => {
    const host = hostRef.current;
    if (!host) return;
    const timelinePx = host.getBoundingClientRect().width;
    const tpp0 = ticksPerPixelRef.current > 0 ? ticksPerPixelRef.current : MOCK_END_TICKS / timelinePx;
    userInteractedRef.current = true; // hold off auto-fit until the animation lands
    zoomAnimRef.current = {
      tpp0,
      start0: startTicksRef.current,
      tppT: MOCK_END_TICKS / timelinePx,
      startT: 0,
      t0: performance.now(),
      releaseFit: true,
    };
  };
  const closeTab = (i: number) => {
    setOpenFiles((fs) => fs.filter((_, k) => k !== i));
    // Keep the active index valid: shift down if it was at/after the closed tab.
    setActiveTab((a) => (a >= i && a > 0 ? a - 1 : a));
  };
  // Commit an edited [start, end] window from the range label. Returns false on
  // invalid input (non-finite, negative, start >= end) so the field can flash.
  const applyRange = (start: number, end: number): boolean => {
    const host = hostRef.current;
    if (!host) return false;
    const timelinePx = host.getBoundingClientRect().width;
    if (timelinePx <= 0 || !isFinite(start) || !isFinite(end) || start < 0 || end <= start) return false;
    zoomAnimRef.current = null;
    userInteractedRef.current = true;
    ticksPerPixelRef.current = (end - start) / timelinePx;
    startTicksRef.current = start;
    // clampPan: keep the window within data bounds (mirrors the wheel handler).
    const visible = timelinePx * ticksPerPixelRef.current;
    if (visible < MOCK_END_TICKS) {
      startTicksRef.current = Math.max(0, Math.min(MOCK_END_TICKS - visible, startTicksRef.current));
    } else {
      startTicksRef.current = 0;
    }
    setViewRange({ start: startTicksRef.current, end: startTicksRef.current + visible });
    return true;
  };
  // Commit an edited cursor time from the cursor pill. Rejects non-finite or
  // negative input so the field flashes.
  const applyCursor = (n: number): boolean => {
    if (!isFinite(n) || n < 0) return false;
    cursorTicksRef.current = n;
    setCursorTicks(n);
    return true;
  };
  // Click the cursor pill: pan so the cursor sits at the left edge, keeping the
  // current zoom (right edge follows from the unchanged ticks_per_pixel). Eased
  // via the zoom-anim ref with tppT == tpp0 so only start_ticks moves.
  const jumpToCursor = () => {
    const tpp = ticksPerPixelRef.current;
    if (tpp <= 0) return;
    userInteractedRef.current = true;
    zoomAnimRef.current = {
      tpp0: tpp,
      start0: startTicksRef.current,
      tppT: tpp,
      startT: cursorTicksRef.current,
      t0: performance.now(),
      releaseFit: false,
    };
  };
  // Commit an edited marker time from its pill. Rejects non-finite/negative.
  const applyMarkerTick = (id: number, n: number): boolean => {
    if (!isFinite(n) || n < 0) return false;
    setMarkers((ms) => ms.map((m) => (m.id === id ? { ...m, tick: n } : m)));
    return true;
  };

  const selectedMarker = markers.find((m) => m.id === selectedMarkerId) ?? null;
  // Live pointer readout. Time shows whenever the pointer is over the canvas;
  // the signal value is a single-point query that only resolves when the
  // pointer is over an actual signal row (off-row → null).
  const hoverSig = hover ? activeSignals.find((r) => r.row === hover.row) ?? null : null;
  const hoverValue = hover && hoverSig
    ? {
      name: getSignal(SCENE.hierarchy, hoverSig.signalId).name,
      value: formatSegmentValue(
        valueAtTick(getSignal(SCENE.hierarchy, hoverSig.signalId).handle, hover.tick),
        getSignal(SCENE.hierarchy, hoverSig.signalId).bitWidth,
        hoverSig.radix,
        ENUM_LABELS_BY_ROW.get(hoverSig.row),
      ),
    }
    : null;

  return (
    <div className="app">
      <div className="titlebar">
        <div className="dots"><i className="r" /><i className="y" /><i className="g" /></div>
        <div className="title">Riptide</div>
        <MenuBar />
        <div className="divider" />
        <div className="tabs">
          {openFiles.map((f, i) => (
            <span
              key={f}
              className={`tab${i === activeTab ? " active" : ""}`}
              onClick={() => setActiveTab(i)}
            >
              {f}
              <span
                className="tab-close"
                data-tip="close file"
                onClick={(e) => { e.stopPropagation(); closeTab(i); }}
              ><X size={11} /></span>
            </span>
          ))}
        </div>
        <div className="sp" />
      </div>

      {/* Row 2 holds the status bar under the two left columns only; the waves
          column spans both rows so its canvas runs full height beside it. */}
      <div className={`body${treeAnim ? " tree-anim" : ""}`} style={{ gridTemplateColumns: `${treeColW}px ${activeColW}px 1fr`, gridTemplateRows: "minmax(0, 1fr) auto" }}>
        {!treeCollapsed && (
          <div
            className="col-resize"
            style={{ left: treeColW - 3 }}
            onPointerDown={startResize("tree")}
            onDoubleClick={() => { setTreeW(TREE_DEFAULT_PX); pulseLayoutAnim(); }}
          />
        )}
        <div
          className="col-resize"
          style={{ left: treeColW + activeColW - 3 }}
          onPointerDown={startResize(activeCollapsed ? "activeCompact" : "active")}
          onDoubleClick={() => {
            // Compact: reset to the auto tight-fit. Full: reset to default width.
            if (activeCollapsed) setActiveCompactW(null);
            else setActiveW(ACTIVE_DEFAULT_PX);
            pulseLayoutAnim();
          }}
        />
        <div className="col">
          {/* Show the collapsed strip only once the width animation finishes;
              during it, keep the expanded content (clipped) so it slides away
              without popping. On expand, the expanded content is shown
              immediately and revealed as the column grows. */}
          {treeCollapsed && !treeToggling ? (
            <>
              <div className="col-head" style={{ justifyContent: "center" }}>
                <span className="collapse" data-tip="expand panel" onClick={() => toggleTree(false)}>
                  <PanelLeftOpen size={14} strokeWidth={1.75} />
                </span>
              </div>
              <div className="col-vtitle">Signal Tree</div>
            </>
          ) : (
            <div className="col-inner" style={{ width: treeW }}>
              {/* Tighter right padding so the collapse button's right gap
                  matches the centered expand button in the collapsed state. */}
              <div className="col-head" style={{ paddingRight: 3 }}>
                <h3>Signal Tree</h3>
                <span className="sp" style={{ flex: 1 }} />
                <span className="collapse" data-tip="collapse panel" onClick={() => toggleTree(true)}>
                  <PanelLeftClose size={14} strokeWidth={1.75} />
                </span>
              </div>
              <div className="col-sub"><input className="search" placeholder="filter scope/name" /></div>
              <SignalTreeView hierarchy={SCENE.hierarchy} expanded={expandedScopes} onToggle={toggleScope} />
            </div>
          )}
        </div>

        <div className="col">
          {/* Swap on the collapse state alone (not the width anim) so a
              double-click resize — which pulses the width anim but doesn't
              change collapse state — never flickers the header. */}
          {activeCollapsed ? (
            <div className="col-head" style={{ paddingRight: 3 }}>
              <h3>Active Signals</h3>
              <span className="sp" style={{ flex: 1 }} />
              <span className="collapse" data-tip="full view" onClick={() => toggleActive(false)}>
                <PanelLeftOpen size={14} strokeWidth={1.75} />
              </span>
            </div>
          ) : (
            <div className="col-head" style={{ paddingRight: 3 }}>
              <h3>Active Signals</h3>
              <span className="sp" style={{ flex: 1 }} />
              {/* Hold the hint back until the expand width anim settles (it rides
                  rowSliding, set only on toggle, so a resize won't flicker it). */}
              {!rowSliding && <span className="hint">{activeSignals.length} active</span>}
              <span className="collapse" data-tip="compact view" onClick={() => toggleActive(true)}>
                <PanelLeftClose size={14} strokeWidth={1.75} />
              </span>
            </div>
          )}
          {/* Filter + header stay in compact mode: the header is one row-height
              tall, so keeping it is what keeps the signal rows lined up with the
              GPU canvas rows in the waves column. In compact the header collapses
              to just "Name" — matching the name-only rows, no value column and no
              empty pin/icon/eye slots eating width. */}
          <div className="col-sub">
            <input className="search" placeholder={activeCollapsed ? "filter signals" : "filter active signals"} />
          </div>
          {activeCollapsed ? (
            <div className="s-head"><span style={{ fontWeight: 700 }}>Name</span></div>
          ) : (
            <div className="s-head">
              <span />
              <span />
              <span>Name</span>
              <span>Value</span>
              <span />
            </div>
          )}
          <div
            className="signals"
            ref={signalsRef}
            onContextMenu={(e) => { e.preventDefault(); setCtxMenu({ x: e.clientX, y: e.clientY }); }}
            onClick={(e) => { if (e.target === e.currentTarget) setActiveSignals((refs) => refs.map((r) => (r.selected ? { ...r, selected: false } : r))); }}
          >
            {activeSignals.map((ref, i) => {
              const sig = getSignal(SCENE.hierarchy, ref.signalId);
              return (
                <ActiveSignal
                  key={i}
                  name={sig.name}
                  kind={activeSignalKind(ref)}
                  radix={ref.radix}
                  color={ref.color}
                  // Disabled for now (kept for re-enable): path · vcd-type tooltip.
                  // tip={`${ref.path} · ${ref.vcdType}`}
                  pinned={ref.pinned}
                  selected={ref.selected}
                  hidden={ref.hidden}
                  collapsed={activeCollapsed}
                  sliding={rowSliding}
                  value={formatSegmentValue(valueAtTick(sig.handle, cursorTicks), sig.bitWidth, ref.radix, ENUM_LABELS_BY_ROW.get(ref.row))}
                  onPinClick={(e) => setPicker({ row: ref.row, anchorRect: (e.currentTarget as HTMLElement).getBoundingClientRect() })}
                  onToggleVisible={() => toggleSignalHidden(ref.row)}
                  onClick={() => handleRowClick(ref.row)}
                />
              );
            })}
          </div>
        </div>

        <div className="col waves" style={{ gridColumn: 3, gridRow: "1 / 3" }}>
          <div className="col-head toolbar">
            <span className="pill" data-tip="jump to cursor" onClick={jumpToCursor}>
              <span className="swatch" />
              <span className="mono">cursor at{" "}
                <span data-tip="edit cursor time" onClick={(e) => e.stopPropagation()}>
                  <EditableNum value={cursorTicks} format={formatTime} onCommit={applyCursor} />
                </span>{" "}ns
              </span>
            </span>
            <div className="seg">
              <span className="btn icon" data-tip="jump to start"><ChevronFirst size={14} /></span>
              <span className="btn icon" data-tip="step back"><ChevronLeft size={14} /></span>
              <span className="btn icon" data-tip="step forward"><ChevronRight size={14} /></span>
              <span className="btn icon" data-tip="jump to end"><ChevronLast size={14} /></span>
            </div>
            <div className="seg">
              <span className="btn icon" data-tip="previous transition"><ArrowLeftToLine size={14} /></span>
              <span className="btn icon" data-tip="next transition"><ArrowRightToLine size={14} /></span>
            </div>
            <span className="sp" style={{ flex: 1 }} />
            <span className="hint mono">
              {formatTimescale(SCENE.hierarchy.timescale)} ·{" "}
              <EditableNum
                value={viewRange.start}
                format={formatTime}
                onCommit={(n) => applyRange(n, viewRange.end)}
              />
              {" – "}
              <EditableNum
                value={viewRange.end}
                format={formatTime}
                onCommit={(n) => applyRange(viewRange.start, n)}
              /> ns
            </span>
            <div className="divider" />
            <div className="seg">
              <span className="btn icon" data-tip="zoom out" onClick={() => zoomBy(ZOOM_STEP)}><Minus size={14} /></span>
              <span className="btn icon" data-tip="zoom to fit" onClick={fitView}><Maximize size={14} /></span>
              <span className="btn icon" data-tip="zoom in" onClick={() => zoomBy(1 / ZOOM_STEP)}><Plus size={14} /></span>
            </div>
            <div className="seg">
              <span
                className={`btn icon${snapCursor ? " on" : ""}`}
                data-tip={snapCursor ? "disable grid snap" : "enable grid snap"}
                onClick={() => setSnapCursor((v) => !v)}
              >
                <Grid2x2 size={14} />
              </span>
              <span
                className={`btn icon${clockAnchor ? " on" : ""}`}
                data-tip={clockAnchor ? "align grid to timescale" : "align grid to clock"}
                onClick={() => setClockAnchor((v) => !v)}
              >
                <Clock size={14} />
              </span>
            </div>
          </div>
          <div className="col-sub">
            <span className="sub-label">MARKERS</span>
            <span className="btn sm icon" data-tip="add marker at cursor" onClick={addMarkerAtCursor}><Plus size={12} /></span>
            <div className="marker-pills">
              {markers.map((m) => (
                <span
                  key={m.id}
                  className={`marker-pill${m.id === selectedMarkerId ? " on" : ""}`}
                  style={{ ["--mk" as string]: markerColorCss(m.color) }}
                  data-tip={m.id === selectedMarkerId ? "click to deselect" : "click to select"}
                  onClick={() => setSelectedMarkerId((sel) => (sel === m.id ? null : m.id))}
                >
                  <span>
                    {m.name} ·{" "}
                    <span data-tip="edit marker time" onClick={(e) => e.stopPropagation()}>
                      {clockAnchor ? (
                        <EditableNum
                          value={m.tick}
                          editValue={clockCycleOf(m.tick)}
                          format={formatClockWhole}
                          onCommit={(n) => applyMarkerTick(m.id, clockCycleToTick(n))}
                        />
                      ) : (
                        <EditableNum value={m.tick} format={formatTime} onCommit={(n) => applyMarkerTick(m.id, n)} />
                      )}
                    </span>
                    {clockAnchor ? null : <>{" "}ns</>}
                  </span>
                  <span
                    className="rm"
                    data-tip="delete marker"
                    onClick={(e) => { e.stopPropagation(); deleteMarker(m.id); }}
                  ><X size={10} /></span>
                </span>
              ))}
            </div>
          </div>

          <div className="wv-canvas">
            <div className="gpu-host" ref={hostRef}>
              <canvas id="gpu" ref={canvasRef} />
            </div>
          </div>
        </div>

        <div className="status" style={{ gridColumn: "1 / 3", gridRow: 2 }}>
          {hover ? (
            <>
              <span className="st-item"><span className="lbl-t">time </span><b>{formatTime(hover.tick)}</b><span className="unit"> ns</span></span>
              <span className="sep">·</span>
              {hoverValue ? (
                <span className="st-item st-val"><span className="lbl-v">{hoverValue.name} = </span><b>{hoverValue.value}</b></span>
              ) : (
                <span className="muted st-item st-val">hover over a signal to inspect</span>
              )}
            </>
          ) : (
            <span className="muted st-item st-val">hover over a signal to inspect</span>
          )}
        </div>
      </div>

      {picker && (
        <ColorPicker
          color={activeSignals.find((r) => r.row === picker.row)?.color ?? "#000000"}
          onChange={(c) => handleColorChange(picker.row, c)}
          onClose={() => setPicker(null)}
          anchorRect={picker.anchorRect}
        />
      )}
      {ctxMenu && (
        <ContextMenu x={ctxMenu.x} y={ctxMenu.y} items={ACTIVE_SIGNAL_MENU} onClose={() => setCtxMenu(null)} />
      )}
      <GlobalTooltip />
    </div>
  );
}
