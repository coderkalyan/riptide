// Ruler / time / clock formatting — pure helpers ported verbatim from the React
// App.tsx. Time is ns (integer ticks). Reused by the canvas ruler + (later) the
// toolbar/markers readouts.
import { MOCK_CLOCK_TICK_NS } from "../../renderer/gpu/data";
import { SCENE } from "../../renderer/hier/scene";
import type { Timescale, TimeUnit } from "../../renderer/hier/types";

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

// Clock period in ticks (full cycle = two half-period segments). Cycle c's rising
// edge lands at MOCK_CLOCK_TICK_NS + (c-1)*PERIOD (5, 15, 25…).
export const CLOCK_PERIOD_NS = 2 * MOCK_CLOCK_TICK_NS;

// Rising edges crossed moving from one tick to the other, in (a, b].
export function clockEdgesBetween(a: number, b: number): number {
  const lo = Math.min(a, b);
  const hi = Math.max(a, b);
  const eps = CLOCK_PERIOD_NS * 1e-6;
  const kHi = Math.floor((hi - MOCK_CLOCK_TICK_NS + eps) / CLOCK_PERIOD_NS);
  const kLo = Math.floor((lo - MOCK_CLOCK_TICK_NS + eps) / CLOCK_PERIOD_NS);
  const kStart = Math.max(kLo + 1, 0);
  return Math.max(0, kHi - kStart + 1);
}

// Integer cycle index a tick sits in (the most recent rising edge). Cycle 1's
// rising edge is at MOCK_CLOCK_TICK_NS.
export function clockCycleOf(tick: number): number {
  const eps = CLOCK_PERIOD_NS * 1e-6;
  return Math.floor((tick - MOCK_CLOCK_TICK_NS + eps) / CLOCK_PERIOD_NS) + 1;
}
// Inverse on edit commit: snap a typed cycle count to a rounded tick.
export function clockCycleToTick(cycle: number): number {
  return cycle * CLOCK_PERIOD_NS;
}
export function formatClockWhole(tick: number): string {
  return `#${clockCycleOf(tick)}`;
}

// Clock-anchored ruler: ticks land on clock rising edges, labels count cycles.
export function clockRulerTicks(startTicks: number, visibleTicks: number): { ticks: number[]; labels: string[] } {
  const edge0 = MOCK_CLOCK_TICK_NS;
  const visibleCycles = visibleTicks / CLOCK_PERIOD_NS;
  const cycleStep = Math.max(1, Math.round(rulerSpacing(visibleCycles)));
  const startCycle = (startTicks - edge0) / CLOCK_PERIOD_NS + 1;
  let c = Math.max(cycleStep, Math.ceil(startCycle / cycleStep) * cycleStep);
  const ticks: number[] = [];
  const labels: string[] = [];
  const end = startTicks + visibleTicks + CLOCK_PERIOD_NS * 1e-6;
  for (; ; c += cycleStep) {
    const t = edge0 + (c - 1) * CLOCK_PERIOD_NS;
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

export function snapToClockEdge(tick: number): number {
  const period = 2 * MOCK_CLOCK_TICK_NS;
  return Math.round((tick - MOCK_CLOCK_TICK_NS) / period) * period + MOCK_CLOCK_TICK_NS;
}
