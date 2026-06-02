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
      {row("cpu encode ms (p50/p95)", `${ms(snap.encode.p50Ms)} / ${ms(snap.encode.p95Ms)}`)}
      {row("main-thread jank", `${snap.jank.longTasks} task / ${snap.jank.longTaskMs.toFixed(0)}ms`, snap.jank.longTasks > 0 ? "#e6b14e" : undefined)}
      <div style={{ height: 1, background: "#2f333a", margin: "5px 0" }} />

      {snap.load
        ? (
          <>
            {row("vcd load total", `${snap.load.total.toFixed(0)}ms`, "#72f5df")}
            {snap.load.phases.map((p) => (
              <div key={p.label} style={{ display: "flex", justifyContent: "space-between", gap: 16, paddingLeft: 8 }}>
                <span style={{ color: "#6f747d", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{p.label}</span>
                <span style={{ color: "#b8b6ad" }}>{p.ms.toFixed(1)}</span>
              </div>
            ))}
          </>
        )
        : row("vcd load", "measuring…")}

      <div style={{ height: 1, background: "#2f333a", margin: "5px 0" }} />
      {snap.add
        ? row("add signal (repack/present)", `${snap.add.total.toFixed(0)}ms (${snap.add.reactAndRepack.toFixed(0)}/${snap.add.present.toFixed(0)})`, "#72f5df")
        : row("add signal", "— add one to measure")}
    </div>
  );
}
