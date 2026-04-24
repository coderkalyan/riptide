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
import { MOCK_END_TICKS, type Segment } from "./gpu/data";
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
      const [multiBit, singleBit] = await Promise.all([
        renderer.buildPipeline("multi", MULTI_BIT_SEGMENTS, colorBuf),
        renderer.buildPipeline("single", SINGLE_BIT_SEGMENTS, colorBuf),
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

        const vp = {
          ticks_per_pixel: MOCK_END_TICKS / canvasRect.width,
          start_ticks: 0,
          width: canvasRect.width,
          height: canvasRect.height,
          row_height: rowHeightCSS,
          dpr,
          selected_row: 4,
        };
        renderFrame(gpuCtx, renderer, [multiBit, singleBit], vp);
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
