// Ruler / time / clock formatting — pure helpers ported verbatim from the React
// App.tsx. Time is ns (integer ticks). Reused by the canvas ruler + (later) the
// toolbar/markers readouts.
import { SCENE } from "../hier/scene";
import type { Timescale, TimeUnit } from "../hier/types";

// The timebase clock grid: phase = tick of the first reference (rising) edge,
// period = full-cycle length in ticks. Detected from the designated clock
// signal's transitions (wave/clock.ts), or set by a manual override. `valid` is
// false when detection couldn't establish a stable period — clock-aligned mode
// falls back to absolute time in that case.
export interface ClockGrid {
  phase: number;
  period: number;
  valid: boolean;
}

// "Nice" ruler-tick spacing — multiples of {1,2,5} × 10^n — so the visible range
// gets ~8 labels.
export function rulerSpacing(visibleTicks: number): number {
  const target = visibleTicks / 8;
  const exp = Math.floor(Math.log10(target));
  const base = Math.pow(10, exp);
  const m = target / base;
  if (m < 2) return base;
  if (m < 5) return 2 * base;
  return 5 * base;
}

function formatRulerLabel(t: number, spacing: number): string {
  const decimals = spacing >= 1 ? 0 : Math.max(0, -Math.floor(Math.log10(spacing)));
  return `${t.toFixed(decimals)} ns`;
}

export function dynamicRulerTicks(startTicks: number, visibleTicks: number): { ticks: number[]; labels: string[] } {
  const spacing = rulerSpacing(visibleTicks);
  const first = Math.ceil(startTicks / spacing) * spacing;
  const ticks: number[] = [];
  const labels: string[] = [];
  const end = startTicks + visibleTicks + spacing * 1e-6;
  for (let t = first; t <= end; t += spacing) {
    ticks.push(t);
    labels.push(formatRulerLabel(t, spacing));
  }
  return { ticks, labels };
}

// Clock math is parameterized by the timebase ClockGrid: cycle c's reference edge
// lands at `g.phase + (c-1)*g.period` (e.g. 5, 15, 25… for phase 5, period 10).

// Rising edges crossed moving from one tick to the other, in (a, b].
export function clockEdgesBetween(a: number, b: number, g: ClockGrid): number {
  const lo = Math.min(a, b);
  const hi = Math.max(a, b);
  const eps = g.period * 1e-6;
  const kHi = Math.floor((hi - g.phase + eps) / g.period);
  const kLo = Math.floor((lo - g.phase + eps) / g.period);
  const kStart = Math.max(kLo + 1, 0);
  return Math.max(0, kHi - kStart + 1);
}

// Integer cycle index a tick sits in (the most recent reference edge). Cycle 1's
// edge is at g.phase.
export function clockCycleOf(tick: number, g: ClockGrid): number {
  const eps = g.period * 1e-6;
  return Math.floor((tick - g.phase + eps) / g.period) + 1;
}
// Inverse on edit commit: snap a typed cycle count to a rounded tick.
export function clockCycleToTick(cycle: number, g: ClockGrid): number {
  return g.phase + (cycle - 1) * g.period;
}
export function formatClockWhole(tick: number, g: ClockGrid): string {
  return `#${clockCycleOf(tick, g)}`;
}

// Clock-anchored ruler: ticks land on clock reference edges, labels count cycles.
export function clockRulerTicks(startTicks: number, visibleTicks: number, g: ClockGrid): { ticks: number[]; labels: string[] } {
  const edge0 = g.phase;
  const visibleCycles = visibleTicks / g.period;
  const cycleStep = Math.max(1, Math.round(rulerSpacing(visibleCycles)));
  const startCycle = (startTicks - edge0) / g.period + 1;
  let c = Math.max(cycleStep, Math.ceil(startCycle / cycleStep) * cycleStep);
  const ticks: number[] = [];
  const labels: string[] = [];
  const end = startTicks + visibleTicks + g.period * 1e-6;
  for (; ; c += cycleStep) {
    const t = edge0 + (c - 1) * g.period;
    if (t > end) break;
    ticks.push(t);
    labels.push(`#${c}`);
  }
  return { ticks, labels };
}

// Verilog-style timescale label: `<unit> / <precision>` (precision optional).
export function formatTimescale(ts: Timescale): string {
  const unit = `${ts.value} ${ts.unit}`;
  return ts.precision ? `${unit} / ${ts.precision.value} ${ts.precision.unit}` : unit;
}

const TIME_UNIT_EXP: Record<TimeUnit, number> = { s: 0, ms: -3, us: -6, ns: -9, ps: -12, fs: -15 };
function timeDecimals(ts: Timescale): number {
  if (!ts.precision) return 0;
  const exp = TIME_UNIT_EXP[ts.precision.unit] - TIME_UNIT_EXP[ts.unit];
  return Math.max(0, -exp - (String(ts.precision.value).length - 1));
}
// Every time readout zero-pads to the file's time precision so values share one
// decimal width. Computed once at module load (matches React's module const).
export const TIME_DECIMALS = timeDecimals(SCENE.hierarchy.timescale);
export const formatTime = (tick: number): string => tick.toFixed(TIME_DECIMALS);

// Snap to the nearest reference edge of the timebase grid (full-period spacing
// from the phase, e.g. …,5,15,25,… for phase 5 / period 10).
export function snapToClockEdge(tick: number, g: ClockGrid): number {
  return Math.round((tick - g.phase) / g.period) * g.period + g.phase;
}
