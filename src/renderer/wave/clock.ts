// Timebase detection — derive a clock's period/phase and a reset's held window
// from the START of the signal's waveform, reading only a cheap prefix of
// transitions (native getEdges → tide queryNext) rather than scanning the whole
// trace. The detected ClockGrid drives all cycle math + the dashed grid; the
// reset band drives the bottom-ruler crosshatch. Both replace the old hardcoded
// MOCK_CLOCK_TICK_NS / RESET_HELD_TICKS shims.
import { getEdges } from "../native";
import type { ClockGrid } from "./format";
import type { ClockPolarity } from "../hier/scene";

// Transitions to sample. A clock toggles twice per cycle, so 32 transitions give
// ~16 cycles — plenty for a stable median while staying a tiny prefix read.
const CLOCK_SAMPLE = 32;
const RESET_SAMPLE = 8;

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

// A transition is "active" for a given polarity when its decoded logic level is
// the reference level: 1 (lsb set, msb clear) for rising, 0 for falling. x/z
// (msb set) are never edges.
function isRefEdge(lsb: number, msb: number, polarity: ClockPolarity): boolean {
  if (msb !== 0) return false;
  const level = lsb !== 0 ? 1 : 0;
  return polarity === "falling" ? level === 0 : level === 1; // "both" → treat as rising
}

// Detect {phase, period} from the first reference edges of a clock signal.
// phase = first reference-edge tick; period = median rising-to-rising interval.
// valid = at least two edges and all intervals within ±25% of the median (a
// crude regularity check so a gated/irregular head is flagged, not trusted).
export function detectClockGrid(handle: string, polarity: ClockPolarity = "rising"): ClockGrid {
  const e = getEdges(handle, 0, CLOCK_SAMPLE);
  if (!e || e.count < 2) return { phase: 0, period: 1, valid: false };

  const edges: number[] = [];
  for (let i = 0; i < e.count; i++) {
    if (isRefEdge(e.lsb[i], e.msb[i], polarity)) edges.push(e.ticks[i]);
  }
  if (edges.length < 2) return { phase: edges[0] ?? 0, period: 1, valid: false };

  const intervals: number[] = [];
  for (let i = 1; i < edges.length; i++) intervals.push(edges[i] - edges[i - 1]);
  const period = median(intervals);
  const valid = period > 0 && intervals.every((d) => Math.abs(d - period) <= period * 0.25);
  return { phase: edges[0], period: period > 0 ? period : 1, valid };
}

// Detect the held interval of a reset: [firstTick, first tick at which the level
// leaves its initial state]. Polarity-agnostic — whatever value reset holds at
// the trace start, the band runs until it first changes. null if it never
// changes within the sampled prefix (or there are no transitions).
export function detectResetBand(handle: string): { tStart: number; tEnd: number } | null {
  const e = getEdges(handle, 0, RESET_SAMPLE);
  if (!e || e.count < 1) return null;
  const tStart = e.ticks[0];
  const lsb0 = e.lsb[0], msb0 = e.msb[0];
  for (let i = 1; i < e.count; i++) {
    if (e.lsb[i] !== lsb0 || e.msb[i] !== msb0) return { tStart, tEnd: e.ticks[i] };
  }
  return null;
}
