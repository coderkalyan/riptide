import { useEffect, useRef, useState } from "react";
import { ArrowLeftToLine, ArrowRightToLine, ChevronFirst, ChevronLast, ChevronLeft, ChevronRight, Flag, Maximize, MessageSquare, Minus, PanelLeftClose, Plus, SplitSquareHorizontal, X } from "lucide-react";
import { ActiveSignal, type ActiveSignalKind } from "./ActiveSignal";
import { ColorPicker } from "./ColorPicker";
import { SignalTreeView } from "./SignalTree";
import { DerivedSignals, DerivedSignal } from "./DerivedSignals";
import { initGPU, resizeCanvas, GPUInitError } from "./gpu/device";
import { createDigitalRenderer } from "./gpu/digital";
import { renderFrame } from "./gpu/frame";
import { createColorBuffer, writeRowColors } from "./gpu/colors";
import { MOCK_CLOCK_TICK_NS, MOCK_END_TICKS, type Segment } from "./gpu/data";
import { createTextRenderer, packRgba, MAX_GLYPHS } from "./gpu/text";
import { createLineRenderer } from "./gpu/lines";
import { createRectRenderer } from "./gpu/rect";
import { MOCK_SCENE, type ActiveSignalRef, type Radix } from "./hier/mock";
import { getSignal } from "./hier/hierarchy";

function activeSignalKind(ref: ActiveSignalRef): ActiveSignalKind {
  if (ref.role === "clock") return "clock";
  if (ref.role === "reset") return "reset";
  if (ref.role === "valid") return "valid";
  if (ref.derivedExpr) return "derived";
  return "signal";
}

const CURSOR_TICKS = 32.4;
const MARKER_TICKS = 19.6;

function findSegmentAtTick(row: number, tick: number): Segment | undefined {
  return MOCK_SCENE.segments.find((segment) => {
    const segmentRow = segment.rowFlags & 0xffff;
    return segmentRow === row && segment.tStart <= tick && tick < segment.tEnd;
  });
}

function formatSegmentValue(segment: Segment | undefined, bitWidth: number, radix: Radix): string {
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
  if (bitWidth === 1) return String(val);
  if (radix === "hex") return `0x${val.toString(16).toUpperCase()}`;
  if (radix === "dec") return String(val);
  return `0b${val.toString(2).padStart(bitWidth, "0")}`;
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
    return { row, tStart: s.tStart, tEnd: s.tEnd, text: formatSegmentValue(s, sig.bitWidth, ref.radix) };
  });

const TEXT_WHITE = packRgba(0xff, 0xff, 0xff, 0xff);
const GRID_GRAY = packRgba(0x86, 0x8c, 0x96, 0x70);
const SELECTED_BG = packRgba(0xff, 0xff, 0xff, 0x0e);
const DEAD_ZONE_GRAY = packRgba(0x78, 0x7c, 0x86, 0x70);
const TIMELINE_FRAC = 0.9; // timeline occupies 90% of canvas; rest is dead zone
// Grid lines are 1.25*dpr CSS px thick (see lines.wgsl). Clock pill edges
// render to the LEFT of their tick (inside the ending segment), so we shift
// the grid's left edge leftward by its own thickness to right-align it.
const GRID_THICKNESS_CSS_PER_DPR = 1.25;

// Clock positive-edge ticks: `buildClockSegments` emits alternating half-period
// segments starting low, so the 0→1 transitions land at ticks 5, 15, 25, ...
const CLOCK_EDGE_TICKS: number[] = [];
for (let t = MOCK_CLOCK_TICK_NS; t < MOCK_END_TICKS; t += 2 * MOCK_CLOCK_TICK_NS) {
  CLOCK_EDGE_TICKS.push(t);
}
export function App() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const signalsRef = useRef<HTMLDivElement>(null);
  const gpuRef = useRef<{ device: GPUDevice; colorBuf: GPUBuffer } | null>(null);

  const [activeSignals, setActiveSignals] = useState<ActiveSignalRef[]>(MOCK_SCENE.activeSignals);
  const [picker, setPicker] = useState<{ row: number; anchorRect: DOMRect } | null>(null);

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
      const [multiBit, singleBit, textRenderer, lineRenderer, rectRenderer] = await Promise.all([
        renderer.buildPipeline("multi", MULTI_BIT_SEGMENTS, colorBuf),
        renderer.buildPipeline("single", SINGLE_BIT_SEGMENTS, colorBuf),
        createTextRenderer(gpuCtx, renderer.uniformBuf),
        createLineRenderer(gpuCtx, renderer.uniformBuf),
        createRectRenderer(gpuCtx, renderer.uniformBuf),
      ]);
      const linesBg = lineRenderer.createBatch();
      const linesFg = lineRenderer.createBatch();
      const rectsBg = rectRenderer.createBatch();

      // Foreground test line: teal dashed marker at ~25% canvas width.
      linesFg.setLines([
        { x: 120, color: packRgba(0x4f, 0xd2, 0xbd, 0xff), dashed: true },
      ]);

      const ro = new ResizeObserver(() => resizeCanvas(canvas));
      ro.observe(canvas);
      resizeCanvas(canvas);

      const frame = () => {
        // All measurements are in CSS pixels from getBoundingClientRect.
        // Multiply by DPR to get physical canvas pixels — the only unit the
        // GPU shader knows about.
        const dpr = window.devicePixelRatio || 1;
        const canvasRect = canvas.getBoundingClientRect();
        const signalsRect = signals.getBoundingClientRect();

        // Row height: measure the first rendered row element directly so any
        // future CSS change (compact mode, zoom) is picked up automatically.
        const firstRow = signals.firstElementChild as HTMLElement | null;
        const rowHeightCSS = firstRow
          ? firstRow.getBoundingClientRect().height
          : 22;

        // Timeline occupies only `TIMELINE_FRAC` of canvas width; the rest
        // becomes a crosshatched dead zone at the right edge.
        const timelinePx = canvasRect.width * TIMELINE_FRAC;
        const ticksPerPixel = MOCK_END_TICKS / timelinePx;
        const vp = {
          ticks_per_pixel: ticksPerPixel,
          start_ticks: 0,
          width: canvasRect.width,
          height: canvasRect.height,
          row_height: rowHeightCSS,
          dpr,
          selected_row: 4,
        };

        // Background rects: gentle highlight behind the selected row + a
        // gray crosshatch over the post-timeline dead zone on the right.
        rectsBg.setRects([
          { x: 0, y: rowHeightCSS * vp.selected_row, w: canvasRect.width, h: rowHeightCSS, color: SELECTED_BG },
          { x: timelinePx, y: 0, w: canvasRect.width - timelinePx, h: canvasRect.height, color: DEAD_ZONE_GRAY, crosshatch: true },
        ]);

        // Grid: dashed vertical lines right-aligned to each clock positive
        // edge (matches the clock pill's right-edge rendering).
        const gridInset = GRID_THICKNESS_CSS_PER_DPR * dpr;
        linesBg.setLines(CLOCK_EDGE_TICKS.map((t) => ({
          x: t / ticksPerPixel - gridInset,
          color: GRID_GRAY,
          dashed: true,
        })));

        // Build glyph instances for multi-bit pill values.
        const cellW = textRenderer.cell.widthPx;
        let gi = 0;
        for (const lbl of MULTI_BIT_LABELS) {
          if (gi >= MAX_GLYPHS) break;
          const startPx = lbl.tStart / ticksPerPixel;
          const endPx = lbl.tEnd / ticksPerPixel;
          const widthPx = endPx - startPx;
          const textWidthPx = lbl.text.length * cellW;
          if (widthPx < textWidthPx + 6) continue; // skip if pill too narrow
          const centerX = (startPx + endPx) * 0.5;
          const x0 = Math.round(centerX - textWidthPx * 0.5);
          const y0 = Math.round(rowHeightCSS * (lbl.row + 0.5) - textRenderer.cell.midlinePx);
          for (let k = 0; k < lbl.text.length && gi < MAX_GLYPHS; k++) {
            const code = lbl.text.charCodeAt(k);
            if (code < 0x20 || code > 0x7e) continue;
            textRenderer.writeGlyph(gi++, x0 + k * cellW, y0, code, TEXT_WHITE);
          }
        }
        textRenderer.setGlyphs(gi);

        renderFrame(gpuCtx, renderer, [multiBit, singleBit], linesBg, rectsBg, linesFg, textRenderer, vp);
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
  }, [activeSignals]);

  const handleColorChange = (row: number, color: string) => {
    setActiveSignals((refs) => refs.map((r) => (r.row === row ? { ...r, color } : r)));
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
        <span className="kbd mono">command palette</span>
      </div>

      <div className="body">
        <div className="col">
          <div className="col-head">
            <h3>Signal Tree</h3>
            <span className="sp" style={{ flex: 1 }} />
            <span className="collapse" title="collapse panel"><PanelLeftClose size={14} strokeWidth={1.75} /></span>
          </div>
          <div className="col-sub"><input className="search" placeholder="filter scope/name" /></div>
          <SignalTreeView hierarchy={MOCK_SCENE.hierarchy} initialExpanded={MOCK_SCENE.initialExpanded} />

          <div className="col-head">
            <h3>Derived Signals</h3>
          </div>
          <div className="col-sub">
            <input className="search" placeholder="new derived expression" />
            <span className="btn sm icon primary" title="add"><Plus size={14} /></span>
          </div>
          <DerivedSignals>
            {activeSignals
              .filter((r) => r.derivedExpr)
              .map((r, i) => {
                const sig = getSignal(MOCK_SCENE.hierarchy, r.signalId);
                return <DerivedSignal key={i} name={sig.name} expr={r.derivedExpr!} />;
              })}
          </DerivedSignals>
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
                  value={formatSegmentValue(findSegmentAtTick(ref.row, CURSOR_TICKS), sig.bitWidth, ref.radix)}
                  onPinClick={(e) => setPicker({ row: ref.row, anchorRect: (e.currentTarget as HTMLElement).getBoundingClientRect() })}
                />
              );
            })}
          </div>
        </div>

        <div className="col waves">
          <div className="col-head toolbar">
            <h3>Waves</h3>
            <div className="divider" />
            <div className="seg">
              <span className="btn icon" title="to beginning"><ChevronFirst size={14} /></span>
              <span className="btn icon" title="step backward"><ChevronLeft size={14} /></span>
              <span className="btn icon" title="step forward"><ChevronRight size={14} /></span>
              <span className="btn icon" title="to end"><ChevronLast size={14} /></span>
            </div>
            <div className="divider" />
            <span className="pill"><span className="swatch" /><span className="mono">cursor 32.400 ns</span></span>
            <div className="divider" />
            <div className="seg">
              <span className="btn icon"><Minus size={14} /></span>
              <span className="btn icon" title="fit"><Maximize size={14} /></span>
              <span className="btn icon"><Plus size={14} /></span>
            </div>
            <span className="sp" style={{ flex: 1 }} />
            <span className="hint mono">1 ns / 14 px · 0 – {MOCK_END_TICKS} ns</span>
            <span className="btn icon ghost">⚙</span>
          </div>
          <div className="col-sub">
            <div className="seg">
              <span className="btn sm"><ArrowLeftToLine size={12} /></span>
              <span className="btn sm"><ArrowRightToLine size={12} /></span>
            </div>
            <div className="divider" />
            <span className="btn sm"><Flag size={12} /> Marker</span>
            <span className="btn sm ghost"><X size={12} /> Clear</span>
            <div className="divider" />
            <span className="btn sm ghost"><MessageSquare size={12} /> Annotate</span>
            <span className="btn sm ghost"><SplitSquareHorizontal size={12} /> Split</span>
            <span className="sp" style={{ flex: 1 }} />
            <div className="seg">
              <span className="btn sm">1 ns</span><span className="btn sm on">10 ns</span><span className="btn sm">100 ns</span><span className="btn sm">1 µs</span>
            </div>
          </div>

          <div className="wv-canvas">
            <div className="ruler">
              {[0, 10, 20, 30, 40, 50, 60, 70, 80, 90].map((t) => (
                <span key={t}>
                  <div className="tk major" style={{ left: `${(t / MOCK_END_TICKS) * 100}%` }} />
                  <div className="lb mono" style={{ left: `${(t / MOCK_END_TICKS) * 100}%` }}>{t} ns</div>
                </span>
              ))}
              <div className="cursor" style={{ left: `${(CURSOR_TICKS / MOCK_END_TICKS) * 100}%` }}><div className="flag">{CURSOR_TICKS.toFixed(3)} ns</div></div>
              <div className="marker" style={{ left: `${(MARKER_TICKS / MOCK_END_TICKS) * 100}%` }}><div className="flag">M1 · {MARKER_TICKS.toFixed(3)} ns</div></div>
            </div>
            <div className="gpu-host">
              <canvas id="gpu" ref={canvasRef} />
            </div>
          </div>
        </div>
      </div>

      <div className="status">
        <span>cursor <b>{CURSOR_TICKS.toFixed(3)} ns</b></span>
        <span>M1 <b>{MARKER_TICKS.toFixed(3)} ns</b></span>
        <span>Δ <b>{(CURSOR_TICKS - MARKER_TICKS).toFixed(3)} ns</b></span>
        <span>zoom <b>1 ns / 14 px</b></span>
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
