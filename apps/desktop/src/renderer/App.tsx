import { useEffect, useRef } from "react";
import { ActiveSignal, ActiveSignalProps } from "./ActiveSignal";
import { SignalTree, Scope, SignalNode } from "./SignalTree";
import { DerivedSignals, DerivedSignal } from "./DerivedSignals";

const ACTIVE_SIGNALS: ActiveSignalProps[] = [
  { name: "clk", value: "1'b0", type: "clk", radix: "bin", pinned: true },
];

export function App() {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const resize = (): void => {
      const dpr = window.devicePixelRatio || 1;
      canvas.width = Math.floor(canvas.clientWidth * dpr);
      canvas.height = Math.floor(canvas.clientHeight * dpr);
    };
    resize();
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
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
        <span className="kbd mono">⌘K  command palette</span>
      </div>

      <div className="body">
        <div className="col">
          <div className="col-head">
            <h3>Signal Tree</h3>
            <span className="sp" style={{ flex: 1 }} />
            {/* <span className="hint">147 signals</span> */}
            <span className="collapse" title="collapse panel">‹</span>
          </div>
          <div className="col-sub"><input className="search" placeholder="filter scope/name" /></div>
          <SignalTree>
            <Scope name="top" badge="module" expanded>
              <Scope name="des" badge="42" />
              <Scope name="keysched" badge="28" expanded>
                <SignalNode name="clk" icon="◷" iconKind="clk" plus />
                <SignalNode name="rst_n" icon="⏚" plus />
                <SignalNode name="c[10:0]" icon="∿" iconKind="bus" plus selected />
                <SignalNode name="load1[0:8]" icon="∿" iconKind="bus" count="3" plus />
                <SignalNode name="load2[0:8]" icon="∿" iconKind="bus" plus />
                <SignalNode name="load3[0:8]" icon="∿" iconKind="bus" count="1" plus />
                <SignalNode name="data[31:0]" icon="∿" iconKind="bus2" plus />
                <SignalNode name="state[1:0]" icon="▦" plus />
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
            <span className="btn sm icon primary" title="add">＋</span>
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
            <span>Name</span>
            <span>Value</span>
            <span />
          </div>
          <div className="signals">
            {ACTIVE_SIGNALS.map((s, i) => <ActiveSignal key={i} {...s} />)}
          </div>
        </div>

        <div className="col waves">
          <div className="col-head toolbar">
            <h3>Waves</h3>
            <div className="divider" />
            <span className="btn icon" title="to beginning">⏮</span>
            <span className="btn icon" title="step backward">⏴</span>
            <span className="btn icon" title="step forward">⏵</span>
            <span className="btn icon" title="to end">⏭</span>
            <div className="divider" />
            <span className="pill"><span className="swatch" /><span className="mono">cursor 32.400 ns</span></span>
            <div className="divider" />
            <div className="seg">
              <span className="btn">−</span><span className="btn" title="fit">⛶</span><span className="btn">＋</span>
            </div>
            <span className="sp" style={{ flex: 1 }} />
            <span className="hint mono">1 ns / 14 px · 0 – 100 ns</span>
            <span className="btn icon ghost">⚙</span>
          </div>
          <div className="col-sub">
            <div className="seg">
              <span className="btn sm">⇤ edge</span><span className="btn sm">edge ⇥</span>
            </div>
            <span className="btn sm">set marker</span>
            <span className="btn sm ghost">clear</span>
            <div className="divider" />
            <span className="btn sm ghost">annotate</span>
            <span className="btn sm ghost">split</span>
            <span className="sp" style={{ flex: 1 }} />
            <div className="seg">
              <span className="btn sm">1 ns</span><span className="btn sm on">10 ns</span><span className="btn sm">100 ns</span><span className="btn sm">1 µs</span>
            </div>
          </div>

          <div className="wv-canvas">
            <div className="ruler">
              {[0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100].map((t) => (
                <span key={t}>
                  <div className="tk major" style={{ left: `${t}%` }} />
                  <div className="lb mono" style={{ left: `${t}%` }}>{t} ns</div>
                </span>
              ))}
            </div>
            <div className="gpu-host">
              <canvas id="gpu" ref={canvasRef} />
            </div>
            <div className="cursor" style={{ left: "32.4%" }}><div className="flag">32.400 ns</div></div>
            <div className="marker" style={{ left: "19.6%" }}><div className="flag">M1 · 19.600 ns</div></div>
          </div>
        </div>
      </div>

      <div className="status">
        {/* <span className="dotted"><span className="dot" />sim ready</span> */}
        <span>cursor <b>32.400 ns</b></span>
        <span>M1 <b>19.600 ns</b></span>
        <span>Δ <b>12.800 ns</b></span>
        <span>zoom <b>1 ns / 14 px</b></span>
        <span className="sp" />
        <span>147 signals</span>
        <span>9 active</span>
        <span>2 derived</span>
        <span>top / keysched</span>
      </div>
    </div>
  );
}
