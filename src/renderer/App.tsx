import { useEffect, useRef, useState } from "react";
import { ArrowLeftToLine, ArrowRightToLine, ChevronFirst, ChevronLast, ChevronLeft, ChevronRight, Clock, Flag, Magnet, Maximize, MessageSquare, Minus, PanelLeftClose, PanelLeftOpen, Plus, SplitSquareHorizontal, X } from "lucide-react";
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
const GRID_GRAY = packRgba(0x86, 0x8c, 0x96, 0x70);
const DEAD_ZONE_GRAY = packRgba(0x78, 0x7c, 0x86, 0x70);
const RESET_RED = packRgba(0xe8, 0x6a, 0x5a, 0x60);
const NOTCH_COLOR = packRgba(0x86, 0x8c, 0x96, 0xff);
const NOTCH_HEIGHT = 12;

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
  const [snapCursor, setSnapCursor] = useState(true);
  const [clockAnchor, setClockAnchor] = useState(false);
  // Cursor needs both a ref (event handlers, frame loop) and state (active-
  // signal value column re-renders on cursor move).
  const [cursorTicks, setCursorTicks] = useState(INITIAL_CURSOR_TICKS);
  const cursorTicksRef = useRef(INITIAL_CURSOR_TICKS);
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
      type RectMut = { x: number; y: number; w: number; h: number; color: number; crosshatch?: boolean; rounded?: boolean };
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
        const { ticks: rulerTicks, spacing: rulerStep } = dynamicRulerTicks(startTicks, visibleTicks);
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
        const lcur = getLine(linesFgScratch, fgLineN++);
        lcur.x = xForTick(cursor); lcur.color = HOT;
        linesFg.setLines(linesFgScratch, fgLineN);

        // Build glyph instances for multi-bit pill values.
        const cellLg = textRenderer.cellLg;
        const cellW = cellLg.widthPx;
        let gi = 0;
        const rulerLabelY = Math.round(rulerHeightCSS * 0.5 + 2);
        for (const t of rulerTicks) {
          gi = writeText(
            textBody,
            gi,
            Math.round(xForTick(t) + 3),
            rulerLabelY,
            formatRulerLabel(t, rulerStep),
            TEXT_SECONDARY,
            true,
          );
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
        const pillH = 16;
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
      } else {
        draggingRef.current = true;
        setCursorAtClientX(e.clientX);
      }
    };
    const onPointerMove = (e: PointerEvent) => {
      if (draggingMarkerRef.current != null) {
        moveMarker(draggingMarkerRef.current, tickAtClientX(e.clientX));
        return;
      }
      if (!draggingRef.current) return;
      setCursorAtClientX(e.clientX);
    };
    const onPointerUp = (e: PointerEvent) => {
      if (draggingMarkerRef.current == null && !draggingRef.current) return;
      draggingMarkerRef.current = null;
      draggingRef.current = false;
      host.releasePointerCapture(e.pointerId);
    };

    host.addEventListener("wheel", onWheel, { passive: false });
    host.addEventListener("pointerdown", onPointerDown);
    host.addEventListener("pointermove", onPointerMove);
    host.addEventListener("pointerup", onPointerUp);
    host.addEventListener("pointercancel", onPointerUp);
    return () => {
      host.removeEventListener("wheel", onWheel);
      host.removeEventListener("pointerdown", onPointerDown);
      host.removeEventListener("pointermove", onPointerMove);
      host.removeEventListener("pointerup", onPointerUp);
      host.removeEventListener("pointercancel", onPointerUp);
    };
  }, []);

  const handleColorChange = (row: number, color: string) => {
    setActiveSignals((refs) => refs.map((r) => (r.row === row ? { ...r, color } : r)));
  };

  const selectedMarker = markers.find((m) => m.id === selectedMarkerId) ?? null;

  const TREE_MIN_PX = 160;
  const ACTIVE_MIN_PX = 200;
  const TREE_COLLAPSED_PX = 28;
  const [treeW, setTreeW] = useState(236);
  const [activeW, setActiveW] = useState(296);
  const [treeCollapsed, setTreeCollapsed] = useState(false);
  const treeColW = treeCollapsed ? TREE_COLLAPSED_PX : treeW;
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

  return (
    <div className="app">
      <div className="titlebar">
        <div className="dots"><i className="r" /><i className="y" /><i className="g" /></div>
        <div className="title">Riptide <span className="sub">— keysched.vcd</span></div>
        <div className="sp" />
      </div>

      <div className="menubar">
        <span className="m">File</span><span className="m">Edit</span><span className="m">View</span>
        <span className="m">Signals</span><span className="m">Markers</span><span className="m">Window</span><span className="m">Help</span>
        <span className="sp" />
      </div>

      <div className="body" style={{ gridTemplateColumns: `${treeColW}px ${activeW}px 1fr` }}>
        {!treeCollapsed && (
          <div className="col-resize" style={{ left: treeColW - 3 }} onPointerDown={startResize("tree")} />
        )}
        <div className="col-resize" style={{ left: treeColW + activeW - 3 }} onPointerDown={startResize("active")} />
        <div className="col">
          {treeCollapsed ? (
            <div className="col-head" style={{ justifyContent: "center" }}>
              <span className="collapse" data-tip="expand panel" onClick={() => setTreeCollapsed(false)}>
                <PanelLeftOpen size={14} strokeWidth={1.75} />
              </span>
            </div>
          ) : (
            <>
              <div className="col-head">
                <h3>Signal Tree</h3>
                <span className="sp" style={{ flex: 1 }} />
                <span className="collapse" data-tip="collapse panel" onClick={() => setTreeCollapsed(true)}>
                  <PanelLeftClose size={14} strokeWidth={1.75} />
                </span>
              </div>
              <div className="col-sub"><input className="search" placeholder="filter scope/name" /></div>
              <SignalTreeView hierarchy={MOCK_SCENE.hierarchy} initialExpanded={MOCK_SCENE.initialExpanded} />
            </>
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
          <div className="signals" ref={signalsRef}>
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

        <div className="col waves">
          <div className="col-head toolbar">
            <h3>Waves</h3>
            <div className="divider" />
            <span className="pill"><span className="swatch" /><span className="mono">cursor {cursorTicks.toFixed(3)} ns</span></span>
            <div className="seg">
              <span className="btn icon" data-tip="to beginning"><ChevronFirst size={14} /></span>
              <span className="btn icon" data-tip="step backward"><ChevronLeft size={14} /></span>
              <span className="btn icon" data-tip="step forward"><ChevronRight size={14} /></span>
              <span className="btn icon" data-tip="to end"><ChevronLast size={14} /></span>
            </div>
            <span
              className={`btn sm icon${snapCursor ? " on" : ""}`}
              data-tip="snap cursor to grid"
              onClick={() => setSnapCursor((v) => !v)}
            >
              <Magnet size={14} />
            </span>
            <span className="sp" style={{ flex: 1 }} />
            <div className="seg">
              <span className="btn icon" data-tip="zoom out" onClick={() => zoomBy(ZOOM_STEP)}><Minus size={14} /></span>
              <span className="btn icon" data-tip="fit" onClick={fitView}><Maximize size={14} /></span>
              <span className="btn icon" data-tip="zoom in" onClick={() => zoomBy(1 / ZOOM_STEP)}><Plus size={14} /></span>
            </div>
            <span
              className={`btn sm icon${clockAnchor ? " on" : ""}`}
              data-tip="anchor timeline to clock"
              onClick={() => setClockAnchor((v) => !v)}
            >
              <Clock size={14} />
            </span>
            <div className="divider" />
            <span className="hint mono">{formatZoom(ticksPerPixel)} · 0 – {MOCK_END_TICKS} ns</span>
          </div>
          <div className="col-sub">
            <div className="seg">
              <span className="btn sm"><ArrowLeftToLine size={12} /></span>
              <span className="btn sm"><ArrowRightToLine size={12} /></span>
            </div>
            <div className="divider" />
            <span className="btn sm" data-tip="add marker at cursor (m)" onClick={addMarkerAtCursor}><Flag size={12} /> Marker</span>
            <span
              className="btn sm ghost"
              data-tip={selectedMarkerId != null ? "delete selected marker (del)" : "clear all markers"}
              onClick={clearMarkers}
            ><X size={12} /> Clear</span>
            <div className="divider" />
            <span className="btn sm ghost"><MessageSquare size={12} /> Annotate</span>
            <span className="btn sm ghost"><SplitSquareHorizontal size={12} /> Split</span>
            <span className="sp" style={{ flex: 1 }} />
          </div>

          <div className="wv-canvas">
            <div className="gpu-host" ref={hostRef}>
              <canvas id="gpu" ref={canvasRef} />
            </div>
          </div>
        </div>
      </div>

      <div className="status">
        <span>cursor <b>{cursorTicks.toFixed(3)} ns</b></span>
        {selectedMarker && <span>{selectedMarker.name} <b>{selectedMarker.tick.toFixed(3)} ns</b></span>}
        {selectedMarker && <span>Δ <b>{(cursorTicks - selectedMarker.tick).toFixed(3)} ns</b></span>}
        <span>markers <b>{markers.length}</b></span>
        <span>zoom <b>{formatZoom(ticksPerPixel)}</b></span>
        <span className="sp" />
        <span>147 signals</span>
        <span>{activeSignals.length} active</span>
        <span>{activeSignals.filter((r) => r.derivedExpr).length} derived</span>
        <span>top / keysched</span>
      </div>

      {picker && (
        <ColorPicker
          color={activeSignals.find((r) => r.row === picker.row)?.color ?? "#000000"}
          onChange={(c) => handleColorChange(picker.row, c)}
          onClose={() => setPicker(null)}
          anchorRect={picker.anchorRect}
        />
      )}
    </div>
  );
}
