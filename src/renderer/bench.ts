// Pack-cost benchmark harness for the viewport-windowed packing migration.
//
// Times native getMockSegments over a sweep of zoom levels and reports the
// bytes moved to the GPU at each, so the "windowing is O(viewport)" claim can be
// measured before/after. Installs window.__bench (call it from DevTools). Gated
// to a console banner by ?bench=1, but the function is always available.
//
// Methodology: for each ticks-per-pixel level, compute the same [qStart, qEnd]
// window the rAF loop would (visible span ± one screen of over-fetch margin),
// pack the current active set K times, and report p50/p95 pack ms plus the
// segment/pool/label byte sizes. On the pre-windowing build, call it with a
// single fit-level tpp (or qEnd === traceEnd) to capture the full-range baseline.

import { getMockSegments, type NativeMockSegments } from "./native";
import { packSpecsFor, type ActiveSignalRef } from "./hier/scene";
import { percentile } from "./perf";

interface BenchRow {
  level: string;
  tpp: number;
  qStart: number;
  qEnd: number;
  windowTicks: number;
  multiCount: number;
  singleCount: number;
  segKiB: number;
  poolKiB: number;
  labelKiB: number;
  totalKiB: number;
  p50ms: number;
  p95ms: number;
}

export interface BenchDeps {
  getActive: () => ActiveSignalRef[];
  getCanvasW: () => number;
  getTraceEnd: () => number;
  /** ?bench=1 → emit a one-line console banner that the harness is ready. */
  announce: boolean;
}

interface BenchOpts {
  /** Left edge of the swept viewport, in ticks (default 0). */
  startTicks?: number;
  /** Ticks-per-pixel levels to sweep (default fit, 1/4, 1/16, 1/64). */
  tppList?: number[];
  /** Pack repetitions per level for the p50/p95 (default 50). */
  iters?: number;
}

function round(x: number, dp = 3): number {
  const m = 10 ** dp;
  return Math.round(x * m) / m;
}

const KiB = (bytes: number): number => round(bytes / 1024, 1);

export function installBench(deps: BenchDeps): void {
  const run = (opts: BenchOpts = {}): BenchRow[] => {
    const active = deps.getActive();
    const canvasW = deps.getCanvasW() || 1000;
    const traceEnd = deps.getTraceEnd();
    const iters = opts.iters ?? 50;
    const start = opts.startTicks ?? 0;
    const fitTpp = traceEnd / canvasW;
    const tppList = opts.tppList ?? [fitTpp, fitTpp / 4, fitTpp / 16, fitTpp / 64];
    const specs = packSpecsFor(active);

    const rows: BenchRow[] = [];
    for (const tpp of tppList) {
      const visibleTicks = canvasW * tpp;
      const margin = visibleTicks; // mirror the rAF loop's one-screen over-fetch
      const qStart = Math.max(0, Math.floor(start - margin));
      const qEnd = Math.min(traceEnd, Math.ceil(start + visibleTicks + margin));

      let last: NativeMockSegments = getMockSegments(specs, qStart, qEnd); // warmup
      const times = new Float64Array(iters);
      for (let i = 0; i < iters; i++) {
        const t0 = performance.now();
        last = getMockSegments(specs, qStart, qEnd);
        times[i] = performance.now() - t0;
      }
      times.sort();

      const segBytes = last.multi.byteLength + last.single.byteLength;
      const poolBytes = last.x0Pool.byteLength + last.x1Pool.byteLength;
      const labelBytes = last.labelBytes.byteLength + last.labelOffsets.byteLength;
      rows.push({
        level: Math.abs(tpp - fitTpp) < 1e-9 ? "fit" : `1/${round(fitTpp / tpp, 1)}`,
        tpp: round(tpp),
        qStart,
        qEnd,
        windowTicks: qEnd - qStart,
        multiCount: last.multiCount,
        singleCount: last.singleCount,
        segKiB: KiB(segBytes),
        poolKiB: KiB(poolBytes),
        labelKiB: KiB(labelBytes),
        totalKiB: KiB(segBytes + poolBytes + labelBytes),
        p50ms: round(percentile(times, 50)),
        p95ms: round(percentile(times, 95)),
      });
    }
    // eslint-disable-next-line no-console
    console.table(rows);
    return rows;
  };

  (window as unknown as { __bench: typeof run }).__bench = run;
  if (deps.announce) {
    // eslint-disable-next-line no-console
    console.info(
      "[bench] window.__bench({ startTicks?, tppList?, iters? }) ready — sweeps pack cost vs zoom",
    );
  }
}
