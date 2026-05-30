import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ArrowLeftToLine, ArrowRightToLine, ChevronFirst, ChevronLast, ChevronLeft, ChevronRight, Clock, Magnet, Maximize, Minus, PanelLeftClose, PanelLeftOpen, Plus, X } from "lucide-react";
import { ActiveSignal, type ActiveSignalKind } from "./ActiveSignal";
import { ColorPicker } from "./ColorPicker";
import { SignalTreeView } from "./SignalTree";
import { initGPU, resizeCanvas, GPUInitError } from "./gpu/device";
import { createDigitalRenderer } from "./gpu/digital";
import { renderFrame } from "./gpu/frame";
import { createColorBuffer, writeRowColors } from "./gpu/colors";
import { MOCK_CLOCK_TICK_NS, MOCK_END_TICKS, type Segment } from "./gpu/data";
import { createTextRenderer, packRgba, MAX_GLYPHS, ATLAS_MIDDLE_DOT } from "./gpu/text";
import { createLineRenderer } from "./gpu/lines";
import { createRectRenderer } from "./gpu/rect";
import { MOCK_SCENE, RESET_HELD_TICKS, type ActiveSignalRef, type Radix } from "./hier/mock";
import { getSignal } from "./hier/hierarchy";
import { getMockSegments } from "./native";

function activeSignalKind(ref: ActiveSignalRef): ActiveSignalKind {
  if (ref.role === "clock") return "clock";
  if (ref.role === "reset") return "reset";
  if (ref.role === "valid") return "valid";
  if (ref.derivedExpr) return "derived";
  return "signal";
}

const INITIAL_CURSOR_TICKS = 32.4;
const MARKER_TICKS = 19.6; // initial M1 position
const ZOOM_PER_DELTA_Y = 0.001; // Math.exp() factor per wheel deltaY unit
const MAX_MARKERS = 16; // size of the pre-allocated pill/line render pool
const MARKER_GRAB_PX = 5; // pointer slop for grabbing a marker line

interface Marker {
  id: number;     // unique, monotonic; also drives the Mn name
  name: string;
  tick: number;
  color: number;  // packed rgba
}

function findSegmentAtTick(row: number, tick: number): Segment | undefined {
  return MOCK_SCENE.segments.find((segment) => {
    const segmentRow = segment.rowFlags & 0xffff;
    return segmentRow === row && segment.tStart <= tick && tick < segment.tEnd;
  });
}

function formatSegmentValue(
  segment: Segment | undefined,
  bitWidth: number,
  radix: Radix,
  enumLabels?: Map<number, string>,
): string {
  if (!segment) return "-";
  const hasX = (segment.valueMsb & ~segment.valueLsb) >>> 0;
  const hasZ = (segment.valueMsb & segment.valueLsb) >>> 0;
  // Any X/Z: fall back to per-bit binary (radix can't represent non-2-state).
  if (hasX || hasZ) {
    const chars: string[] = [];
    for (let bit = bitWidth - 1; bit >= 0; bit--) {
      const l = (segment.valueLsb >>> bit) & 1;
      const m = (segment.valueMsb >>> bit) & 1;
      if (m === 0 && l === 0) chars.push("0");
      else if (m === 0 && l === 1) chars.push("1");
      else if (m === 1 && l === 0) chars.push("x");
      else chars.push("z");
    }
    return bitWidth === 1 ? chars[0] : `0b${chars.join("")}`;
  }
  const val = segment.valueLsb >>> 0;
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
for (const ref of MOCK_SCENE.activeSignals) {
  const sig = getSignal(MOCK_SCENE.hierarchy, ref.signalId);
  if (sig.enumTypeId == null) continue;
  const enumType = MOCK_SCENE.hierarchy.enumTypes.get(sig.enumTypeId);
  if (!enumType) continue;
  const m = new Map<number, string>();
  for (const mem of enumType.members) m.set(parseInt(mem.raw, 2), mem.label);
  ENUM_LABELS_BY_ROW.set(ref.row, m);
}

const SINGLE_BIT_SEGMENTS = MOCK_SCENE.segments.filter((s) => {
  const ref = MOCK_SCENE.activeSignals.find((r) => r.row === (s.rowFlags & 0xffff));
  if (!ref) return false;
  return getSignal(MOCK_SCENE.hierarchy, ref.signalId).bitWidth === 1;
});
const MULTI_BIT_SEGMENTS = MOCK_SCENE.segments.filter((s) => {
  const ref = MOCK_SCENE.activeSignals.find((r) => r.row === (s.rowFlags & 0xffff));
  if (!ref) return false;
  return getSignal(MOCK_SCENE.hierarchy, ref.signalId).bitWidth > 1;
});

interface MultiBitLabel {
  row: number;
  tStart: number;
  tEnd: number;
  text: string;
}

const FLAG_MUTE = 1 << 20;
const MULTI_BIT_LABELS: MultiBitLabel[] = MULTI_BIT_SEGMENTS
  .filter((s) => (s.rowFlags & FLAG_MUTE) === 0)
  .map((s) => {
    const row = s.rowFlags & 0xffff;
    const ref = MOCK_SCENE.activeSignals.find((r) => r.row === row)!;
    const sig = getSignal(MOCK_SCENE.hierarchy, ref.signalId);
    return { row, tStart: s.tStart, tEnd: s.tEnd, text: formatSegmentValue(s, sig.bitWidth, ref.radix, ENUM_LABELS_BY_ROW.get(row)) };
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

function dynamicRulerTicks(startTicks: number, visibleTicks: number): { ticks: number[]; spacing: number } {
  const spacing = rulerSpacing(visibleTicks);
  const first = Math.ceil(startTicks / spacing) * spacing;
  const ticks: number[] = [];
  // Tolerance avoids dropping ticks at the right edge due to fp accumulation.
  const end = startTicks + visibleTicks + spacing * 1e-6;
  for (let t = first; t <= end; t += spacing) ticks.push(t);
  return { ticks, spacing };
}

function formatRulerLabel(t: number, spacing: number): string {
  const decimals = spacing >= 1 ? 0 : Math.max(0, -Math.floor(Math.log10(spacing)));
  return `${t.toFixed(decimals)} ns`;
}

function formatZoom(ticksPerPixel: number): string {
  if (!isFinite(ticksPerPixel) || ticksPerPixel <= 0) return "— ns / — px";
  const pxPerNs = 1 / ticksPerPixel;
  if (pxPerNs >= 1) {
    const d = pxPerNs >= 100 ? 0 : pxPerNs >= 10 ? 1 : 2;
    return `1 ns / ${pxPerNs.toFixed(d)} px`;
  }
  const nsPerPx = ticksPerPixel;
  const d = nsPerPx >= 100 ? 0 : nsPerPx >= 10 ? 1 : 2;
  return `${nsPerPx.toFixed(d)} ns / 1 px`;
}

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
    const onOver = (e: MouseEvent) => {
      const el = (e.target as HTMLElement | null)?.closest("[data-tip]") as HTMLElement | null;
      if (el === current) return;
      current = el;
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
        setShow(false);
      }
    };
    document.addEventListener("mouseover", onOver);
    document.addEventListener("mouseout", onOut);
    return () => {
      document.removeEventListener("mouseover", onOver);
      document.removeEventListener("mouseout", onOut);
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
  const userInteractedRef = useRef(false);
  const draggingRef = useRef(false);

  const [activeSignals, setActiveSignals] = useState<ActiveSignalRef[]>(MOCK_SCENE.activeSignals);
  const [picker, setPicker] = useState<{ row: number; anchorRect: DOMRect } | null>(null);
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number } | null>(null);
  const [snapCursor, setSnapCursor] = useState(true);
  const [clockAnchor, setClockAnchor] = useState(false);
  // Cursor needs both a ref (event handlers, frame loop) and state (active-
  // signal value column re-renders on cursor move).
  const [cursorTicks, setCursorTicks] = useState(INITIAL_CURSOR_TICKS);
  const cursorTicksRef = useRef(INITIAL_CURSOR_TICKS);
  // Live pointer readout for the status bar: the unsnapped tick under the
  // pointer and the signal row it's over (null when off the wave area). Drives
  // a per-move single-point value query, independent of the selected cursor.
  const [hover, setHover] = useState<{ tick: number; row: number } | null>(null);
  // Ref drives the rAF guide line; written synchronously in the pointer handler
  // (not synced from `hover` state) so the line tracks the pointer with no
  // React-commit lag. `hover` state only feeds the status-bar text.
  const hoverRef = useRef<{ tick: number; row: number } | null>(null);
  // Mirror of `ticksPerPixelRef` for reactive zoom labels. Synced from RAF.
  const [ticksPerPixel, setTicksPerPixel] = useState(0);
  const ticksPerPixelReportedRef = useRef(0);
  const snapCursorRef = useRef(snapCursor);
  useEffect(() => { snapCursorRef.current = snapCursor; }, [snapCursor]);

  // Markers — both state (status bar, toolbar) and refs (RAF loop, pointer
  // handlers). markerSeqRef issues monotonic ids/names so deletes never reuse a
  // name. Initialized with M1 to match the prior single hardcoded marker.
  const [markers, setMarkers] = useState<Marker[]>([
    { id: 1, name: "M1", tick: MARKER_TICKS, color: MARKER_PALETTE[0] },
  ]);
  const markersRef = useRef(markers);
  useEffect(() => { markersRef.current = markers; }, [markers]);
  const markerSeqRef = useRef(2);
  const [selectedMarkerId, setSelectedMarkerId] = useState<number | null>(1);
  const selectedMarkerIdRef = useRef<number | null>(1);
  useEffect(() => { selectedMarkerIdRef.current = selectedMarkerId; }, [selectedMarkerId]);
  // Per-frame marker hit boxes (CSS px) + ruler height, for pointer grabbing.
  const markerHitsRef = useRef<{ id: number; x0: number; x1: number; lineX: number }[]>([]);
  const rulerHeightRef = useRef(0);
  const draggingMarkerRef = useRef<number | null>(null);

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
  const selectedRowRef = useRef(MOCK_SCENE.activeSignals.find((r) => r.selected)?.row ?? -1);
  useEffect(() => {
    selectedRowRef.current = activeSignals.find((r) => r.selected)?.row ?? -1;
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
      writeRowColors(device, colorBuf, MOCK_SCENE.activeSignals);
      gpuRef.current = { device, colorBuf };
      const renderer = createDigitalRenderer(gpuCtx);
      const native = getMockSegments();
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
      type RectMut = { x: number; y: number; w: number; h: number; color: number; crosshatch?: boolean; rounded?: boolean; caret?: boolean; caretRight?: boolean };
      type LineMut = { x: number; color: number; dashed?: boolean };
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
        return r;
      };
      const getLine = (arr: LineMut[], i: number): LineMut => {
        let l = arr[i];
        if (!l) { l = { x: 0, color: 0 }; arr[i] = l; }
        l.dashed = undefined;
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

      const frame = () => {
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

        // Auto-fit until the user interacts, then freeze.
        if (!userInteractedRef.current || ticksPerPixelRef.current <= 0) {
          ticksPerPixelRef.current = MOCK_END_TICKS / timelinePx;
          startTicksRef.current = 0;
        }
        const ticksPerPixel = ticksPerPixelRef.current;
        if (ticksPerPixel !== ticksPerPixelReportedRef.current) {
          ticksPerPixelReportedRef.current = ticksPerPixel;
          setTicksPerPixel(ticksPerPixel);
        }
        const startTicks = startTicksRef.current;
        const visibleTicks = timelinePx * ticksPerPixel;
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
        const { ticks: rulerTicks, spacing: rulerStep } = dynamicRulerTicks(startTicks, visibleTicks);
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
            r.x = xForTick(t); r.y = notchY; r.w = 2; r.h = NOTCH_HEIGHT; r.color = NOTCH_COLOR;
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
            r.x = xForTick(t); r.y = canvasH - NOTCH_HEIGHT; r.w = 2; r.h = NOTCH_HEIGHT; r.color = NOTCH_COLOR;
          }
          // Double-headed span arrow in the empty band above the notches:
          // open caret_sdf chevrons (see rect.wgsl) at each end, a shaft split
          // around a centered label (dimension-line style). Used for both the
          // marker↔cursor delta and the reset-held region.
          const arrowY = bottomRulerTop + (bottomRulerH - NOTCH_HEIGHT) * 0.5;
          const drawSpanArrow = (leftX: number, rightX: number, label: string, color: number) => {
            const headW = 12, headH = 10, shaftH = 2, gap = 6;
            const leftApex = leftX + gap;
            const rightApex = rightX - gap;
            const cellSm = textRenderer.cellSm;
            const textW = label.length * cellSm.widthPx;
            const labelPad = 5;
            const midX = (leftApex + rightApex) * 0.5;
            const splitL = midX - textW * 0.5 - labelPad;
            const splitR = midX + textW * 0.5 + labelPad;
            const labelFits = splitL > leftApex + 2 && splitR < rightApex - 2;
            const drawShaft = (x0: number, x1: number) => {
              if (x1 <= x0) return;
              const sh = getRect(rectsBgScratch, bgRectN++);
              sh.x = x0; sh.y = arrowY - shaftH * 0.5; sh.w = x1 - x0; sh.h = shaftH; sh.color = color;
            };
            if (labelFits) {
              drawShaft(leftApex, splitL);
              drawShaft(splitR, rightApex);
              rulerArrowLabels.push({
                x: Math.round(midX - textW * 0.5),
                y: Math.round(arrowY - cellSm.midlinePx),
                text: label,
                color,
              });
            } else {
              drawShaft(leftApex, rightApex);
            }
            // Left head "<" (apex on leftApex), right head ">" on rightApex.
            const lh = getRect(rectsBgScratch, bgRectN++);
            lh.x = leftApex - headW * 0.5; lh.y = arrowY - headH * 0.5;
            lh.w = headW; lh.h = headH; lh.color = color; lh.caret = true; lh.caretRight = false;
            const rh = getRect(rectsBgScratch, bgRectN++);
            rh.x = rightApex - headW * 0.5; rh.y = arrowY - headH * 0.5;
            rh.w = headW; rh.h = headH; rh.color = color; rh.caret = true; rh.caretRight = true;
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
          // xForTick gives each line's LEFT edge, so add half the 1.25*dpr line
          // width to center on it.
          const arrowMarker =
            markersRef.current.find((m) => m.id === selectedMarkerIdRef.current);
          if (arrowMarker) {
            const lineHalf = 1.25 * dpr * 0.5;
            const mX = xForTick(arrowMarker.tick) + lineHalf;
            const cX = xForTick(cursor) + lineHalf;
            drawSpanArrow(
              Math.min(mX, cX),
              Math.max(mX, cX),
              `${Math.abs(cursor - arrowMarker.tick).toFixed(3)} ns`,
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
          lh.x = xForTick(hov.tick); lh.color = GRID_GRAY; lh.dashed = true;
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
        for (const t of rulerTicks) {
          const lx = Math.round(xForTick(t) + 3);
          const label = formatRulerLabel(t, rulerStep);
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
          // the per-row contrast pick. Forced white for now.
          const color = TEXT_WHITE;
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
          // Default anchor: pill's left edge sits on the line. Near the right
          // canvas edge, slide the pill leftward so it stays on-screen — at
          // x == canvas.right, pill's right edge sits on the line. Linear
          // ramp over the last `pillW` px of canvas (interior is dead zone,
          // no pill movement). Final clamp keeps the pill fully on-screen.
          const flipStart = canvasW - pillW;
          const t = Math.max(0, Math.min(1, (x - flipStart) / pillW));
          const pillX = Math.max(0, Math.min(canvasW - pillW, x - t * pillW));
          const pillY = 0;
          const r = getRect(pillRectScratch, 0);
          r.x = pillX; r.y = pillY; r.w = pillW; r.h = pillH; r.color = color; r.rounded = true;
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
          const box = addFlag(lineX, `${m.name} · ${m.tick.toFixed(3)} ns`, m.color, markerPills[mi]);
          hits.push({ id: m.id, x0: box.x0, x1: box.x1, lineX });
          mi++;
        }
        for (; mi < markerPills.length; mi++) {
          markerPills[mi].rects.setRects(pillRectScratch, 0);
          markerPills[mi].text.setGlyphs(0);
        }
        addFlag(xForTick(cursor), `${cursor.toFixed(3)} ns`, HOT, pillCursor);

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
      if (py < rh || row < 0 || row >= MOCK_SCENE.activeSignals.length) row = -1;
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
  const [treeW, setTreeW] = useState(TREE_DEFAULT_PX);
  const [activeW, setActiveW] = useState(ACTIVE_DEFAULT_PX);
  const [treeCollapsed, setTreeCollapsed] = useState(false);
  const treeColW = treeCollapsed ? TREE_COLLAPSED_PX : treeW;
  // Enable the width transition only for the duration of a collapse/expand
  // toggle (or a double-click width reset), so live drag-resize stays instant.
  const [treeAnim, setTreeAnim] = useState(false);
  const treeAnimTimer = useRef<number | null>(null);
  const pulseLayoutAnim = () => {
    setTreeAnim(true);
    if (treeAnimTimer.current != null) clearTimeout(treeAnimTimer.current);
    treeAnimTimer.current = window.setTimeout(() => setTreeAnim(false), 140);
  };
  const toggleTree = (collapsed: boolean) => {
    setTreeCollapsed(collapsed);
    pulseLayoutAnim();
  };
  const startResize = (which: "tree" | "active") => (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    const startX = e.clientX;
    const startTree = treeW;
    const startActive = activeW;
    const target = e.currentTarget;
    target.setPointerCapture(e.pointerId);
    target.classList.add("dragging");
    const onMove = (ev: PointerEvent) => {
      const dx = ev.clientX - startX;
      if (which === "tree") setTreeW(Math.max(TREE_MIN_PX, startTree + dx));
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

  const ZOOM_STEP = 1.25;
  const zoomBy = (factor: number) => {
    const host = hostRef.current;
    if (!host) return;
    const timelinePx = host.getBoundingClientRect().width;
    userInteractedRef.current = true;
    const centerX = timelinePx * 0.5;
    const worldTickAtCenter = startTicksRef.current + centerX * ticksPerPixelRef.current;
    ticksPerPixelRef.current *= factor;
    startTicksRef.current = worldTickAtCenter - centerX * ticksPerPixelRef.current;
    const visible = timelinePx * ticksPerPixelRef.current;
    if (visible < MOCK_END_TICKS) {
      startTicksRef.current = Math.max(0, Math.min(MOCK_END_TICKS - visible, startTicksRef.current));
    } else {
      startTicksRef.current = 0;
    }
  };
  const fitView = () => {
    const host = hostRef.current;
    if (!host) return;
    const timelinePx = host.getBoundingClientRect().width;
    ticksPerPixelRef.current = MOCK_END_TICKS / timelinePx;
    startTicksRef.current = 0;
    userInteractedRef.current = false;
  };

  const selectedMarker = markers.find((m) => m.id === selectedMarkerId) ?? null;
  // Resolve the live pointer readout: signal name + single-point value query at
  // the hovered tick. null signal (off-row) collapses the readout entirely.
  const hoverSig = hover ? activeSignals.find((r) => r.row === hover.row) ?? null : null;
  const hoverReadout = hover && hoverSig
    ? {
      tick: hover.tick,
      name: getSignal(MOCK_SCENE.hierarchy, hoverSig.signalId).name,
      value: formatSegmentValue(
        findSegmentAtTick(hoverSig.row, hover.tick),
        getSignal(MOCK_SCENE.hierarchy, hoverSig.signalId).bitWidth,
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
          <span className="tchip active"><i className="dot" />keysched.vcd</span>
          <span className="tchip inactive">alu_tb.vcd</span>
        </div>
        <div className="sp" />
      </div>

      {/* Row 2 holds the status bar under the two left columns only; the waves
          column spans both rows so its canvas runs full height beside it. */}
      <div className={`body${treeAnim ? " tree-anim" : ""}`} style={{ gridTemplateColumns: `${treeColW}px ${activeW}px 1fr`, gridTemplateRows: "minmax(0, 1fr) auto" }}>
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
          style={{ left: treeColW + activeW - 3 }}
          onPointerDown={startResize("active")}
          onDoubleClick={() => { setActiveW(ACTIVE_DEFAULT_PX); pulseLayoutAnim(); }}
        />
        <div className="col">
          {/* Show the collapsed strip only once the width animation finishes;
              during it, keep the expanded content (clipped) so it slides away
              without popping. On expand, the expanded content is shown
              immediately and revealed as the column grows. */}
          {treeCollapsed && !treeAnim ? (
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
              <SignalTreeView hierarchy={MOCK_SCENE.hierarchy} initialExpanded={MOCK_SCENE.initialExpanded} />
            </div>
          )}
        </div>

        <div className="col">
          <div className="col-head"><h3>Active Signals</h3><span className="hint">{activeSignals.length} active</span></div>
          <div className="col-sub">
            <input className="search" placeholder="filter active signals" />
          </div>
          <div className="s-head">
            <span />
            <span />
            <span>Name</span>
            <span>Value</span>
            <span />
          </div>
          <div
            className="signals"
            ref={signalsRef}
            onContextMenu={(e) => { e.preventDefault(); setCtxMenu({ x: e.clientX, y: e.clientY }); }}
            onClick={(e) => { if (e.target === e.currentTarget) setActiveSignals((refs) => refs.map((r) => (r.selected ? { ...r, selected: false } : r))); }}
          >
            {activeSignals.map((ref, i) => {
              const sig = getSignal(MOCK_SCENE.hierarchy, ref.signalId);
              return (
                <ActiveSignal
                  key={i}
                  name={sig.name}
                  kind={activeSignalKind(ref)}
                  radix={ref.radix}
                  color={ref.color}
                  pinned={ref.pinned}
                  selected={ref.selected}
                  value={formatSegmentValue(findSegmentAtTick(ref.row, cursorTicks), sig.bitWidth, ref.radix, ENUM_LABELS_BY_ROW.get(ref.row))}
                  onPinClick={(e) => setPicker({ row: ref.row, anchorRect: (e.currentTarget as HTMLElement).getBoundingClientRect() })}
                  onClick={() => handleRowClick(ref.row)}
                />
              );
            })}
          </div>
        </div>

        <div className="col waves" style={{ gridColumn: 3, gridRow: "1 / 3" }}>
          <div className="col-head toolbar">
            <h3>Waves</h3>
            <div className="divider" />
            <span className="pill"><span className="swatch" /><span className="mono">cursor {cursorTicks.toFixed(3)} ns</span></span>
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
                <Magnet size={14} />
              </span>
              <span
                className={`btn icon${clockAnchor ? " on" : ""}`}
                data-tip={clockAnchor ? "align grid to timescale" : "align grid to clock"}
                onClick={() => setClockAnchor((v) => !v)}
              >
                <Clock size={14} />
              </span>
            </div>
            <div className="divider" />
            <span className="hint mono">{formatZoom(ticksPerPixel)} · 0 – {MOCK_END_TICKS} ns</span>
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
                  {m.name} · {m.tick.toFixed(3)} ns
                  <span
                    className="rm"
                    data-tip="delete marker"
                    onClick={(e) => { e.stopPropagation(); deleteMarker(m.id); }}
                  ><X size={10} /></span>
                </span>
              ))}
            </div>
            <span className="sp" style={{ flex: 1 }} />
          </div>

          <div className="wv-canvas">
            <div className="gpu-host" ref={hostRef}>
              <canvas id="gpu" ref={canvasRef} />
            </div>
          </div>
        </div>

        <div className="status" style={{ gridColumn: "1 / 3", gridRow: 2 }}>
          {hoverReadout ? (
            <>
              <span>time <b>{hoverReadout.tick.toFixed(3)} ns</b></span>
              <span>{hoverReadout.name} = <b>{hoverReadout.value}</b></span>
            </>
          ) : (
            <span className="muted">hover over a signal to inspect</span>
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
