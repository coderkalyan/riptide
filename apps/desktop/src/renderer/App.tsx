import { useEffect, useRef } from "react";
import { ArrowLeftToLine, ArrowRightToLine, ChevronFirst, ChevronLast, ChevronLeft, ChevronRight, Flag, Maximize, MessageSquare, Minus, PanelLeftClose, Plus, SplitSquareHorizontal, X } from "lucide-react";
import { ActiveSignal, ActiveSignalProps } from "./ActiveSignal";
import { SignalTree, Scope, SignalNode } from "./SignalTree";
import { DerivedSignals, DerivedSignal } from "./DerivedSignals";
import { initGPU, resizeCanvas, GPUInitError } from "./gpu/device";
import { buildMultiBitPipeline, buildSingleBitPipeline } from "./gpu/pipelines/digital";
import { renderFrame } from "./gpu/frame";
import {
  MOCK_END_TICKS,
  MOCK_MULTI_BIT_SEGMENTS,
  MOCK_SINGLE_BIT_SEGMENTS,
  MOCK_VALID_DATA_SEGMENTS,
  type Segment,
} from "./gpu/data";

const CURSOR_TICKS = 32.4;
const MARKER_TICKS = 19.6;
const ALL_SEGMENTS = [...MOCK_SINGLE_BIT_SEGMENTS, ...MOCK_MULTI_BIT_SEGMENTS, ...MOCK_VALID_DATA_SEGMENTS];

interface SignalDef {
  name: string;
  type: ActiveSignalProps["type"];
  radix: string;
  row: number;
  bitWidth: number;
  pinned?: boolean;
  selected?: boolean;
}

const ACTIVE_SIGNAL_DEFS: SignalDef[] = [
  { name: "single_clk_posedge", type: "clk", radix: "bin", row: 0, bitWidth: 1, pinned: true },
  { name: "single_data_mix_a", type: "bool", radix: "bin", row: 1, bitWidth: 1 },
  { name: "single_data_mix_b", type: "bool", radix: "bin", row: 2, bitWidth: 1 },
  { name: "single_data_mix_c", type: "drv", radix: "bin", row: 3, bitWidth: 1 },
  { name: "multi_data_2b", type: "bool", radix: "bin", row: 4, bitWidth: 2, selected: true },
  { name: "multi_data_4b", type: "bool", radix: "bin", row: 5, bitWidth: 4 },
  { name: "multi_data_8b", type: "bool", radix: "bin", row: 6, bitWidth: 8 },
  { name: "multi_data_12b", type: "drv", radix: "bin", row: 7, bitWidth: 12 },
  { name: "valid", type: "bool", radix: "bin", row: 8, bitWidth: 1 },
  { name: "data[7:0]", type: "bool", radix: "hex", row: 9, bitWidth: 8 },
  { name: "bit_muted", type: "bool", radix: "bin", row: 10, bitWidth: 1 },
];

function findSegmentAtTick(row: number, tick: number): Segment | undefined {
  return ALL_SEGMENTS.find((segment) => {
    const segmentRow = segment.rowFlags & 0xffff;
    return segmentRow === row && segment.tStart <= tick && tick < segment.tEnd;
  });
}

function formatSegmentValue(segment: Segment | undefined, bitWidth: number): string {
  if (!segment) return "-";
  const chars: string[] = [];
  for (let bit = bitWidth - 1; bit >= 0; bit--) {
    const l = (segment.valueLsb >> bit) & 1;
    const m = (segment.valueMsb >> bit) & 1;
    if (m === 0 && l === 0) chars.push("0");
    else if (m === 0 && l === 1) chars.push("1");
    else if (m === 1 && l === 0) chars.push("x");
    else chars.push("z");
  }
  return bitWidth === 1 ? chars[0] : `0b${chars.join("")}`;
}

const ACTIVE_SIGNALS: ActiveSignalProps[] = ACTIVE_SIGNAL_DEFS.map((def) => ({
  name: def.name,
  type: def.type,
  radix: def.radix,
  pinned: def.pinned,
  selected: def.selected,
  value: formatSegmentValue(findSegmentAtTick(def.row, CURSOR_TICKS), def.bitWidth),
}));
export function App() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const signalsRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const signals = signalsRef.current;
    if (!canvas || !signals) return;

    let raf = 0;

    initGPU(canvas).then(({ device, ctx, format }) => {
      const gpuCtx = { device, ctx, format };
      const singleBitVD = MOCK_VALID_DATA_SEGMENTS.filter((s) => { const r = s.rowFlags & 0xffff; return r === 8 || r === 10; });
      const multiBitVD = MOCK_VALID_DATA_SEGMENTS.filter((s) => (s.rowFlags & 0xffff) === 9);
      const multiBit = buildMultiBitPipeline(gpuCtx, [...MOCK_MULTI_BIT_SEGMENTS, ...multiBitVD]);
      const singleBit = buildSingleBitPipeline(gpuCtx, [...MOCK_SINGLE_BIT_SEGMENTS, ...singleBitVD]);

      const ro = new ResizeObserver(() => resizeCanvas(canvas, device, ctx, format));
      ro.observe(canvas);
      resizeCanvas(canvas, device, ctx, format);

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
        renderFrame(gpuCtx, [multiBit, singleBit], vp);
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

  return (
    <div className="app">
      <div className="titlebar">
        <div className="dots"><i className="r" /><i className="y" /><i className="g" /></div>
        <div className="title">Riptide <span className="sub">— keysched.vcd</span></div>
        <div className="sp" />
        {/* <span className="tchip mono">top / keysched</span> */}
        {/* <span className="tchip"><span className="dot" />connected</span> */}
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
            {/* <span className="hint">147 signals</span> */}
            <span className="collapse" title="collapse panel"><PanelLeftClose size={14} strokeWidth={1.75} /></span>
          </div>
          <div className="col-sub"><input className="search" placeholder="filter scope/name" /></div>
          <SignalTree>
            <Scope name="top" badge="module" expanded>
              <Scope name="des" badge="42" />
              <Scope name="keysched" badge="28" expanded>
                <SignalNode name="clk" iconKind="clk" plus />
                <SignalNode name="rst_n" plus />
                <SignalNode name="c[10:0]" iconKind="bus" plus selected />
                <SignalNode name="load1[0:8]" iconKind="bus" plus />
                <SignalNode name="load2[0:8]" iconKind="bus" plus />
                <SignalNode name="load3[0:8]" iconKind="bus" plus />
                <SignalNode name="data[31:0]" iconKind="bus2" plus />
                <SignalNode name="state[1:0]" iconKind="state" plus />
                <Scope name="fsm" badge="9" />
                <Scope name="xbar" badge="14" />
              </Scope>
              <Scope name="mem_ctrl" badge="31" />
              <Scope name="dma" badge="22" />
              <Scope name="uart" badge="11" />
            </Scope>
          </SignalTree>

          <div className="col-head">
            <h3>Derived Signals</h3>
            {/* <span className="hint">4 rows</span> */}
          </div>
          <div className="col-sub">
            <input className="search" placeholder="new derived expression" />
            <span className="btn sm icon primary" title="add"><Plus size={14} /></span>
          </div>
          <DerivedSignals>
            <DerivedSignal name="busy_any" expr="load1 | load2 | load3" />
            <DerivedSignal name="state_name" expr="decode(state, IDLE,SEND,RECV)" />
            <DerivedSignal name="data_valid" expr="state == SEND && clk" />
            <DerivedSignal name="cafe_match" expr="data[31:0] == 0xCAFEB0BA" />
          </DerivedSignals>
        </div>

        <div className="col">
          <div className="col-head"><h3>Active Signals</h3><span className="hint">{ACTIVE_SIGNALS.length} active</span></div>
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
            {ACTIVE_SIGNALS.map((s, i) => <ActiveSignal key={i} {...s} />)}
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
        {/* <span className="dotted"><span className="dot" />sim ready</span> */}
        <span>cursor <b>{CURSOR_TICKS.toFixed(3)} ns</b></span>
        <span>M1 <b>{MARKER_TICKS.toFixed(3)} ns</b></span>
        <span>Δ <b>{(CURSOR_TICKS - MARKER_TICKS).toFixed(3)} ns</b></span>
        <span>zoom <b>1 ns / 14 px</b></span>
        <span className="sp" />
        <span>147 signals</span>
        <span>{ACTIVE_SIGNALS.length} active</span>
        <span>2 derived</span>
        <span>top / keysched</span>
      </div>
    </div>
  );
}
