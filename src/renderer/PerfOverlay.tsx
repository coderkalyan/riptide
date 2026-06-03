import { Show, For, createSignal, onMount, onCleanup, createEffect, type JSX } from "solid-js";
import * as perf from "./perf";

// Live perf HUD. Hidden until perf is enabled (?perf=1, the ` toggle, or
// window.__perf.enable()). Polls the snapshot a few times a second while visible.
// Fixed top-right, monospace, click-through.

const BUDGET = 1000 / 60;
function fps(v: number): string { return v > 0 ? v.toFixed(0) : "—"; }
function ms(v: number): string { return v > 0 ? v.toFixed(2) : "—"; }
function budgetColor(frameMs: number): string {
  if (frameMs <= 0) return "#8a8f98";
  if (frameMs > BUDGET) return "#f06b5b";
  if (frameMs > BUDGET * 0.75) return "#e6b14e";
  return "#57c88a";
}

export function PerfOverlay() {
  const [on, setOn] = createSignal(perf.isEnabled());
  const [snap, setSnap] = createSignal<perf.PerfSnapshot | null>(null);

  onMount(() => { const unsub = perf.onEnabledChange(setOn); onCleanup(unsub); });
  createEffect(() => {
    if (!on()) return;
    const tick = () => setSnap(perf.snapshot());
    tick();
    const id = window.setInterval(tick, 250);
    onCleanup(() => window.clearInterval(id));
  });

  const row = (label: string, value: string, color?: string): JSX.Element => (
    <div style={{ display: "flex", "justify-content": "space-between", gap: "16px" }}>
      <span style={{ color: "#8a8f98" }}>{label}</span>
      <span style={{ color: color ?? "#e8e6df" }}>{value}</span>
    </div>
  );
  const phaseRow = (label: string, msVal: number, recurs = false): JSX.Element => (
    <div style={{ display: "flex", "justify-content": "space-between", gap: "16px", "padding-left": "8px" }}>
      <span style={{ color: "#6f747d", overflow: "hidden", "text-overflow": "ellipsis", "white-space": "nowrap" }}>
        {recurs && <span style={{ color: "#72f5df" }} title="also runs on each Open-VCD">↻ </span>}{label}
      </span>
      <span style={{ color: "#b8b6ad" }}>{msVal.toFixed(1)}</span>
    </div>
  );
  const caption = (text: string, note: string): JSX.Element => (
    <div style={{ "margin-bottom": "1px" }}>
      <span style={{ color: "#c4c3bb", "font-weight": 700, "font-size": "10px", "letter-spacing": "0.5px" }}>{text.toUpperCase()}</span>
      <span style={{ color: "#6f747d", "margin-left": "6px" }}>{note}</span>
    </div>
  );
  const recursOnOpen = (label: string) => /loadVcd|hierarchy|scene build|segment pack/.test(label);
  const sep = () => <div style={{ height: "1px", background: "#2f333a", margin: "5px 0" }} />;

  return (
    <Show when={on() && snap()}>
      {(s) => (
        <div style={{
          position: "fixed", top: "8px", right: "8px", "z-index": 9999, "pointer-events": "none",
          font: "11px/1.5 'JetBrains Mono', monospace",
          background: "rgba(20,21,23,0.86)", border: "1px solid #2f333a", "border-radius": "6px",
          padding: "8px 10px", "min-width": "240px", color: "#e8e6df",
          "backdrop-filter": "blur(4px)", "box-shadow": "0 4px 16px rgba(0,0,0,0.4)",
        }}>
          <div style={{ "font-weight": 700, "margin-bottom": "4px", "letter-spacing": "0.4px" }}>
            PERF <span style={{ color: "#8a8f98", "font-weight": 400 }}>· ` to hide</span>
          </div>

          {row("electron fps (p50/min)", `${fps(s().present.fps)} / ${fps(s().present.minFps)}`, budgetColor(s().present.p50Ms))}
          {row("frame ms (p50/p95/max)", `${ms(s().present.p50Ms)} / ${ms(s().present.p95Ms)} / ${ms(s().present.maxMs)}`, budgetColor(s().present.p95Ms))}
          {row("dropped frames", `${s().present.dropped}`, s().present.dropped > 0 ? "#e6b14e" : undefined)}
          {sep()}

          {s().gpu.supported
            ? row("canvas gpu ms (p50/p95)", `${ms(s().gpu.p50Ms)} / ${ms(s().gpu.p95Ms)}`, budgetColor(s().gpu.p95Ms))
            : row("canvas gpu ms", "n/a (no timestamp-query)")}
          {row("cpu frame ms (p50/p95)", `${ms(s().cpu.p50Ms)} / ${ms(s().cpu.p95Ms)}`, budgetColor(s().cpu.p95Ms))}
          {phaseRow("of which encode (p50)", s().encode.p50Ms)}
          {row("main-thread jank", `${s().jank.longTasks} task / ${s().jank.longTaskMs.toFixed(0)}ms`, s().jank.longTasks > 0 ? "#e6b14e" : undefined)}
          {sep()}

          {caption("boot", "once · ↻ = also per open")}
          <Show when={s().load} fallback={row("boot → first frame", "measuring…")}>
            {row("boot → first frame", `${s().load!.total.toFixed(0)}ms · ${s().load!.nodes} nodes`, "#72f5df")}
            <For each={s().load!.phases}>{(p) => phaseRow(p.label, p.ms, recursOnOpen(p.label))}</For>
          </Show>
          {sep()}

          {caption("open vcd", "each open · reuses device + pipelines")}
          <Show when={s().swap} fallback={row("open → first frame", "— open a VCD to measure")}>
            {row("open → first frame", `${s().swap!.total.toFixed(0)}ms · ${s().swap!.rows} rows`, "#72f5df")}
            <For each={s().swap!.phases}>{(p) => phaseRow(p.label, p.ms)}</For>
          </Show>
          {sep()}

          {caption("add signal", "each add")}
          <Show when={s().add} fallback={row("add → first frame", "— add one to measure")}>
            {row("add → first frame", `${s().add!.total.toFixed(0)}ms · ${s().add!.rows} rows`, "#72f5df")}
            <For each={s().add!.phases}>{(p) => phaseRow(p.label, p.ms)}</For>
          </Show>
        </div>
      )}
    </Show>
  );
}
