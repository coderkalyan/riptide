import { useEffect, useState } from "react";
import * as perf from "./perf";

// Live perf HUD. Hidden until perf is enabled (?perf=1, the `~` toggle, or
// window.__perf.enable()). Polls the snapshot a few times a second — cheap, and
// only while visible. Fixed top-right, monospace, click-through.

const BUDGET = 1000 / 60;

function fps(v: number): string { return v > 0 ? v.toFixed(0) : "—"; }
function ms(v: number): string { return v > 0 ? v.toFixed(2) : "—"; }

// Red when over the 60fps frame budget, amber when within 25% of it, else green.
function budgetColor(frameMs: number): string {
  if (frameMs <= 0) return "#8a8f98";
  if (frameMs > BUDGET) return "#f06b5b";
  if (frameMs > BUDGET * 0.75) return "#e6b14e";
  return "#57c88a";
}

export function PerfOverlay() {
  const [on, setOn] = useState(perf.isEnabled());
  const [snap, setSnap] = useState<perf.PerfSnapshot | null>(null);

  useEffect(() => perf.onEnabledChange(setOn), []);
  useEffect(() => {
    if (!on) return;
    const tick = () => setSnap(perf.snapshot());
    tick();
    const id = window.setInterval(tick, 250);
    return () => window.clearInterval(id);
  }, [on]);

  if (!on || !snap) return null;

  const presentMs = snap.present.p50Ms;
  const row = (label: string, value: string, color?: string) => (
    <div style={{ display: "flex", justifyContent: "space-between", gap: 16 }}>
      <span style={{ color: "#8a8f98" }}>{label}</span>
      <span style={{ color: color ?? "#e8e6df" }}>{value}</span>
    </div>
  );
  // Indented sub-phase row for the load / add-signal / swap breakdowns. `recurs`
  // tags a boot phase that also runs on every Open-VCD (↻), so the boot list
  // shows at a glance which work is one-time vs repeated per open.
  const phaseRow = (label: string, ms: number, recurs = false) => (
    <div key={label} style={{ display: "flex", justifyContent: "space-between", gap: 16, paddingLeft: 8 }}>
      <span style={{ color: "#6f747d", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        {recurs && <span style={{ color: "#72f5df" }} title="also runs on each Open-VCD">↻ </span>}{label}
      </span>
      <span style={{ color: "#b8b6ad" }}>{ms.toFixed(1)}</span>
    </div>
  );
  // Section caption: bold uppercase label + dim note (e.g. "once" / "each open").
  const caption = (text: string, note: string) => (
    <div style={{ marginBottom: 1 }}>
      <span style={{ color: "#c4c3bb", fontWeight: 700, fontSize: 10, letterSpacing: 0.5 }}>{text.toUpperCase()}</span>
      <span style={{ color: "#6f747d", marginLeft: 6 }}>{note}</span>
    </div>
  );
  // Boot phases whose work also recurs on every Open-VCD (the rest — bundle eval,
  // addon require, GPU init, React mount, paint — happen only once at boot).
  const recursOnOpen = (label: string) =>
    /loadVcd|hierarchy|scene build|segment pack/.test(label);

  return (
    <div
      style={{
        position: "fixed", top: 8, right: 8, zIndex: 9999, pointerEvents: "none",
        font: "11px/1.5 'JetBrains Mono', monospace",
        background: "rgba(20,21,23,0.86)", border: "1px solid #2f333a", borderRadius: 6,
        padding: "8px 10px", minWidth: 240, color: "#e8e6df",
        backdropFilter: "blur(4px)", boxShadow: "0 4px 16px rgba(0,0,0,0.4)",
      }}
    >
      <div style={{ fontWeight: 700, marginBottom: 4, letterSpacing: 0.4 }}>
        PERF <span style={{ color: "#8a8f98", fontWeight: 400 }}>· ` to hide</span>
      </div>

      {row("electron fps (p50/min)", `${fps(snap.present.fps)} / ${fps(snap.present.minFps)}`, budgetColor(presentMs))}
      {row("frame ms (p50/p95/max)", `${ms(presentMs)} / ${ms(snap.present.p95Ms)} / ${ms(snap.present.maxMs)}`, budgetColor(snap.present.p95Ms))}
      {row("dropped frames", `${snap.present.dropped}`, snap.present.dropped > 0 ? "#e6b14e" : undefined)}
      <div style={{ height: 1, background: "#2f333a", margin: "5px 0" }} />

      {snap.gpu.supported
        ? row("canvas gpu ms (p50/p95)", `${ms(snap.gpu.p50Ms)} / ${ms(snap.gpu.p95Ms)}`, budgetColor(snap.gpu.p95Ms))
        : row("canvas gpu ms", "n/a (no timestamp-query)")}
      {row("cpu frame ms (p50/p95)", `${ms(snap.cpu.p50Ms)} / ${ms(snap.cpu.p95Ms)}`, budgetColor(snap.cpu.p95Ms))}
      {phaseRow("of which encode (p50)", snap.encode.p50Ms)}
      {row("main-thread jank", `${snap.jank.longTasks} task / ${snap.jank.longTaskMs.toFixed(0)}ms`, snap.jank.longTasks > 0 ? "#e6b14e" : undefined)}
      <div style={{ height: 1, background: "#2f333a", margin: "5px 0" }} />

      {caption("boot", "once · ↻ = also per open")}
      {snap.load
        ? (
          <>
            {row("boot → first frame", `${snap.load.total.toFixed(0)}ms · ${snap.load.nodes} nodes`, "#72f5df")}
            {snap.load.phases.map((p) => phaseRow(p.label, p.ms, recursOnOpen(p.label)))}
          </>
        )
        : row("boot → first frame", "measuring…")}

      <div style={{ height: 1, background: "#2f333a", margin: "5px 0" }} />
      {caption("open vcd", "each open · reuses device + pipelines")}
      {snap.swap
        ? (
          <>
            {row("open → first frame", `${snap.swap.total.toFixed(0)}ms · ${snap.swap.rows} rows`, "#72f5df")}
            {snap.swap.phases.map((p) => phaseRow(p.label, p.ms))}
          </>
        )
        : row("open → first frame", "— open a VCD to measure")}

      <div style={{ height: 1, background: "#2f333a", margin: "5px 0" }} />
      {caption("add signal", "each add")}
      {snap.add
        ? (
          <>
            {row("add → first frame", `${snap.add.total.toFixed(0)}ms · ${snap.add.rows} rows`, "#72f5df")}
            {snap.add.phases.map((p) => phaseRow(p.label, p.ms))}
          </>
        )
        : row("add → first frame", "— add one to measure")}
    </div>
  );
}
