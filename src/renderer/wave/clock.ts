// Timebase detection — derive a clock's period/phase from the START of the
// signal's waveform, reading only a cheap prefix of transitions (native getEdges
// → tide queryNext) rather than scanning the whole trace. The detected ClockGrid
// drives all cycle math + the dashed grid, replacing the old hardcoded
// MOCK_CLOCK_TICK_NS shim. The bottom-ruler reset crosshatch is built per frame
// from resetHighSpans over the visible window (see WaveCanvas).
import { getEdges, getValueAt } from "../native";
import type { ClockGrid } from "./format";
import type { ClockPolarity } from "../hier/scene";

// Transitions to sample. A clock toggles twice per cycle, so 32 transitions give
// ~16 cycles — plenty for a stable median while staying a tiny prefix read.
const CLOCK_SAMPLE = 32;
// Transitions to pull per getEdges call while walking a reset's visible window.
const RESET_CHUNK = 64;

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

// A 1-bit signal is "high" when its decoded logic level is 1: lsb set, msb clear
// (msb set means x/z — never counted as high).
function isHigh(lsb: number, msb: number): boolean {
  return msb === 0 && lsb !== 0;
}

// Every interval within [winStart, winEnd] where a reset signal is held HIGH,
// clamped to the window. Drives the bottom-ruler crosshatch: each band marks a
// timespan the reset is asserted-high. Cost is O(visible transitions) — one
// getValueAt for the level at the window's left edge, then paginated getEdges
// across the window — not a whole-trace scan. An active-low reset simply yields
// no high spans here. Empty when the handle is unknown or the window is empty.
export function resetHighSpans(
  handle: string,
  winStart: number,
  winEnd: number,
): { tStart: number; tEnd: number }[] {
  if (winEnd <= winStart) return [];
  const spans: { tStart: number; tEnd: number }[] = [];
  // Level entering the window: getValueAt reflects any transition exactly at
  // winStart, so the matching edge below is skipped (hi === high), no double count.
  const v0 = getValueAt(handle, winStart);
  let high = v0 ? isHigh(v0.lsb[0] ?? 0, v0.msb[0] ?? 0) : false;
  let open = high ? winStart : -1;
  let cursor = winStart;
  for (;;) {
    const e = getEdges(handle, cursor, RESET_CHUNK);
    if (!e || e.count === 0) break;
    let past = false;
    for (let i = 0; i < e.count; i++) {
      const t = e.ticks[i];
      if (t > winEnd) { past = true; break; }
      const hi = isHigh(e.lsb[i], e.msb[i]);
      if (hi === high) continue; // not a level change (or the edge at winStart)
      high = hi;
      if (hi) open = t;
      else if (open >= 0) { spans.push({ tStart: open, tEnd: t }); open = -1; }
    }
    if (past || e.count < RESET_CHUNK) break;
    cursor = e.ticks[e.count - 1] + 1; // ticks are distinct integers — no re-read
  }
  if (open >= 0) spans.push({ tStart: open, tEnd: winEnd }); // still high at window end
  return spans;
}
