// Perf instrumentation — four tracked concerns:
//   1. Canvas (WebGPU) frame time — real GPU ms via timestamp-query (gpu/timing.ts
//      feeds pushGpu); canvas fps = 1000/gpu_ms. Full per-frame CPU ms (whole rAF
//      callback) tracked alongside, with the encode+submit subset broken out.
//   2. Electron (main-thread) present fps — rAF interval, with dropped-frame and
//      long-task (jank) detection. This is the "never below 60fps" headline.
//   3. VCD load breakdown — module-load stamps (native db, hierarchy, scene,
//      initial pack) + GPU init + first frame, finalized on the first frame.
//   4. Add-signal latency — click → GPU repack → next presented frame.
//
// Frame metering + load stamps are always on (negligible cost). GPU timestamp
// queries + the overlay are gated by `enabled` (?perf=1, the `~`/backtick
// toggle, or window.__perf.enable()), persisted in sessionStorage so it survives
// the reload that "Open VCD…" triggers. Surfaced live via PerfOverlay and the
// window.__perf console API.

const FRAME_BUDGET_MS = 1000 / 60;
const DROP_THRESHOLD_MS = FRAME_BUDGET_MS * 1.5; // a frame longer than this = a drop
const WINDOW = 180; // ~3s of samples at 60fps

// ---- enable flag (persisted across the Open-VCD reload) -----------------

const STORAGE_KEY = "riptide.perf.enabled";
let enabled = false;
try {
  const q = new URLSearchParams(location.search).get("perf");
  if (q === "1") sessionStorage.setItem(STORAGE_KEY, "1");
  enabled = sessionStorage.getItem(STORAGE_KEY) === "1";
} catch { /* sessionStorage/location unavailable (non-browser) */ }

const enableSubs = new Set<(on: boolean) => void>();
export function onEnabledChange(fn: (on: boolean) => void): () => void {
  enableSubs.add(fn);
  return () => enableSubs.delete(fn);
}
export function isEnabled(): boolean { return enabled; }
export function setEnabled(on: boolean): void {
  if (on === enabled) return;
  enabled = on;
  try { sessionStorage.setItem(STORAGE_KEY, on ? "1" : "0"); } catch { /* ignore */ }
  for (const fn of enableSubs) fn(on);
}

// ---- rolling sample rings -----------------------------------------------

interface Ring { buf: Float64Array; len: number; head: number; }
function ring(n: number): Ring { return { buf: new Float64Array(n), len: 0, head: 0 }; }
function push(r: Ring, v: number): void {
  r.buf[r.head] = v;
  r.head = (r.head + 1) % r.buf.length;
  if (r.len < r.buf.length) r.len++;
}
function snapshotSorted(r: Ring): Float64Array {
  const out = r.buf.slice(0, r.len);
  out.sort();
  return out;
}
// Exported for the bench harness (window.__bench) so it can report p50/p95 over
// repeated pack timings with the same percentile convention as the perf overlay.
export function percentile(sorted: Float64Array, p: number): number {
  if (sorted.length === 0) return 0;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.round((p / 100) * (sorted.length - 1))));
  return sorted[i];
}

const dtRing = ring(WINDOW);       // inter-frame interval (ms) → present fps
const cpuRing = ring(WINDOW);      // full per-frame CPU time (whole rAF callback, ms)
const encodeRing = ring(WINDOW);   // CPU time to encode+submit a frame (ms) — subset of cpu
const gpuRing = ring(WINDOW);      // GPU time for the render pass (ms)
let lastFrameTs = 0;
let dropped = 0;                   // frames slower than DROP_THRESHOLD_MS, lifetime
let frames = 0;
let emaFps = 0;                    // smoothed instantaneous present fps

// ---- long-task (main-thread jank) observer ------------------------------

let longTaskCount = 0;
let longTaskMs = 0;
try {
  const obs = new PerformanceObserver((list) => {
    for (const e of list.getEntries()) { longTaskCount++; longTaskMs += e.duration; }
  });
  obs.observe({ type: "longtask", buffered: true });
} catch { /* longtask unsupported */ }

// ---- frame metering ------------------------------------------------------

// Call at the top of the rAF callback with the rAF timestamp.
export function frameStart(now: number): void {
  if (lastFrameTs > 0) {
    const dt = now - lastFrameTs;
    push(dtRing, dt);
    if (dt > DROP_THRESHOLD_MS) dropped++;
    const inst = 1000 / dt;
    emaFps = emaFps === 0 ? inst : emaFps * 0.9 + inst * 0.1;
  }
  lastFrameTs = now;
  frames++;
}

// Call at the end of the rAF callback. `cpuMs` is the full main-thread cost of
// the whole callback (layout reads, geometry builds, encode+submit) — the number
// that gates 60fps; `encodeMs` is the encode+submit subset of it.
// Finalizes a pending add-signal measurement once its repacked frame has drawn.
export function frameEnd(encodeMs: number, cpuMs: number): void {
  push(encodeRing, encodeMs);
  push(cpuRing, cpuMs);
  if (pendingAdd && pendingAdd.rebuilt) {
    lastAdd = finalizeMarks(pendingAdd);
    pendingAdd = null;
  }
  if (pendingSwap && pendingSwap.rebuilt) {
    lastSwap = finalizeMarks(pendingSwap);
    pendingSwap = null;
  }
}

// Close out a marks list with a final "present" boundary and difference the marks
// into named phases. Shared by the add-signal and trace-swap measurements.
function finalizeMarks(p: { marks: PhaseMark[]; rows: number }): PhaseReport {
  const marks = [...p.marks, { label: "present (next frame draw)", t: performance.now() }];
  const phases: { label: string; ms: number }[] = [];
  for (let i = 1; i < marks.length; i++) phases.push({ label: marks[i].label, ms: marks[i].t - marks[i - 1].t });
  return { total: marks[marks.length - 1].t - marks[0].t, rows: p.rows, phases };
}

// Fed asynchronously by the GPU timer (gpu/timing.ts) a frame or two late.
export function pushGpu(ms: number): void { push(gpuRing, ms); }

// ---- one-shot stamps (VCD load breakdown) -------------------------------

const stamps = new Map<string, number>();
// performance.now() is ms since timeOrigin (navigation start of this page load),
// so stamps are directly comparable to the page-load clock.
export function stamp(label: string): void { stamps.set(label, performance.now()); }

export interface LoadReport {
  total: number;                  // navigation start → first frame
  nodes: number;                  // hierarchy node count, for correlating tree-mount cost
  phases: { label: string; ms: number }[];
}
let lastLoad: LoadReport | null = null;
let hierarchyNodes = 0;
export function setHierarchyNodes(n: number): void { hierarchyNodes = n; }

// Called once the first canvas frame has presented. Builds the load breakdown
// as a CONTIGUOUS segmentation from navigation start (t=0 on the performance.now
// clock = timeOrigin) through each stamp to the first frame. Segments telescope,
// so they sum to the total — time that used to hide between bracketed spans
// (bundle download/parse/eval, the native .node require/dlopen, Solid rendering
// the whole UI before the GPU init, the rAF wait) is now its own visible row.
// Each label describes the work done in the interval ending at that stamp.
export function markFirstFrame(): void {
  if (lastLoad) return; // first frame only
  stamp("frame:first");
  const boundaries: [string, string][] = [
    ["native:require", "bundle download + parse + eval"],
    ["native:start", "native addon require (.node dlopen)"],
    ["native:end", "native db load (loadVcd)"],
    ["scene:hierarchy", "hierarchy decode"],
    ["scene:end", "scene build (overlays/sidecar)"],
    ["pack:end", "initial segment pack"],
    ["render:start", "app module eval tail (labels)"],
    ["render:committed", "solid render + commit (build DOM)"],
    ["gpu:start", "browser layout + paint"],
    ["gpu:ready", "GPU init (adapter/device/pipelines)"],
    ["frame:first", "first frame draw + present"],
  ];
  const phases: { label: string; ms: number }[] = [];
  let prev = 0;
  for (const [key, label] of boundaries) {
    const t = stamps.get(key);
    if (t == null) continue; // missing stamp: fold its interval into the next
    phases.push({ label, ms: t - prev });
    prev = t;
  }
  const first = stamps.get("frame:first") ?? performance.now();
  lastLoad = { total: first, nodes: hierarchyNodes, phases };
  if (enabled) console.log(`[perf] VCD load ${first.toFixed(1)}ms · ${hierarchyNodes} hierarchy nodes (sums to total)`, lastLoad.phases);
}

// ---- add-signal latency --------------------------------------------------

// Add-signal latency is measured as an ordered list of marks; each mark's label
// describes the work done since the previous mark. The repack marks are emitted
// from inside the GPU rebuild closure (App.tsx) so the native pack, GPU buffer
// rebuild, and label rebuild are each broken out.
interface PhaseMark { label: string; t: number }
interface PhaseReport { total: number; rows: number; phases: { label: string; ms: number }[] }
type Pending = { marks: PhaseMark[]; rows: number; rebuilt: boolean };

let pendingAdd: Pending | null = null;
let lastAdd: PhaseReport | null = null;

// Click on a tree "+" — start the clock.
export function beginAdd(): void { pendingAdd = { marks: [{ label: "_start", t: performance.now() }], rows: 0, rebuilt: false }; }
// Record a sub-phase boundary (label = work done since the previous mark). Cheap
// no-op when no add is in flight.
export function addMark(label: string): void { if (pendingAdd) pendingAdd.marks.push({ label, t: performance.now() }); }
// GPU buffers repacked for the new active set — flag it so frameEnd finalizes
// once the resulting frame presents.
export function markAddRebuilt(rows: number): void {
  if (pendingAdd) { pendingAdd.rows = rows; pendingAdd.rebuilt = true; }
}

// ---- trace-swap latency (in-app "Open VCD…") -----------------------------
// Same marks-based shape as add-signal: click → native loadVcd → buildScene →
// GPU repack → next presented frame.
let pendingSwap: Pending | null = null;
let lastSwap: PhaseReport | null = null;

export function beginSwap(): void { pendingSwap = { marks: [{ label: "_start", t: performance.now() }], rows: 0, rebuilt: false }; }
export function swapMark(label: string): void { if (pendingSwap) pendingSwap.marks.push({ label, t: performance.now() }); }
export function markSwapRebuilt(rows: number): void {
  if (pendingSwap) { pendingSwap.rows = rows; pendingSwap.rebuilt = true; }
}

// ---- snapshot + console API ---------------------------------------------

export interface PerfSnapshot {
  enabled: boolean;
  frames: number;
  present: { fps: number; minFps: number; p50Ms: number; p95Ms: number; maxMs: number; dropped: number };
  cpu: { p50Ms: number; p95Ms: number; maxMs: number };
  encode: { p50Ms: number; p95Ms: number; maxMs: number };
  gpu: { p50Ms: number; p95Ms: number; maxMs: number; supported: boolean };
  jank: { longTasks: number; longTaskMs: number };
  load: LoadReport | null;
  add: PhaseReport | null;
  swap: PhaseReport | null;
}

let gpuSupported = false;
export function setGpuSupported(v: boolean): void { gpuSupported = v; }

export function snapshot(): PerfSnapshot {
  const dt = snapshotSorted(dtRing);
  const cpu = snapshotSorted(cpuRing);
  const enc = snapshotSorted(encodeRing);
  const gpu = snapshotSorted(gpuRing);
  const maxDt = dt.length ? dt[dt.length - 1] : 0;
  return {
    enabled,
    frames,
    present: {
      fps: emaFps,
      minFps: maxDt > 0 ? 1000 / maxDt : 0,
      p50Ms: percentile(dt, 50),
      p95Ms: percentile(dt, 95),
      maxMs: maxDt,
      dropped,
    },
    cpu: { p50Ms: percentile(cpu, 50), p95Ms: percentile(cpu, 95), maxMs: cpu.length ? cpu[cpu.length - 1] : 0 },
    encode: { p50Ms: percentile(enc, 50), p95Ms: percentile(enc, 95), maxMs: enc.length ? enc[enc.length - 1] : 0 },
    gpu: { p50Ms: percentile(gpu, 50), p95Ms: percentile(gpu, 95), maxMs: gpu.length ? gpu[gpu.length - 1] : 0, supported: gpuSupported },
    jank: { longTasks: longTaskCount, longTaskMs },
    load: lastLoad,
    add: lastAdd,
    swap: lastSwap,
  };
}

export function reset(): void {
  dtRing.len = dtRing.head = 0;
  cpuRing.len = cpuRing.head = 0;
  encodeRing.len = encodeRing.head = 0;
  gpuRing.len = gpuRing.head = 0;
  lastFrameTs = 0; dropped = 0; frames = 0; emaFps = 0;
  longTaskCount = 0; longTaskMs = 0;
}

// `~` / backtick toggles the overlay + heavy GPU metering. Ignored while typing.
try {
  window.addEventListener("keydown", (e) => {
    if (e.key !== "`" && e.key !== "~") return;
    const el = e.target as HTMLElement | null;
    if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable)) return;
    setEnabled(!enabled);
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (window as any).__perf = {
    snapshot,
    reset,
    enable: () => setEnabled(true),
    disable: () => setEnabled(false),
    toggle: () => setEnabled(!enabled),
    dump() {
      const s = snapshot();
      console.log(
        `[perf] present ${s.present.fps.toFixed(1)}fps (min ${s.present.minFps.toFixed(1)}, ${s.present.dropped} dropped) · ` +
        `gpu p50 ${s.gpu.p50Ms.toFixed(2)}ms p95 ${s.gpu.p95Ms.toFixed(2)}ms · ` +
        `cpu p50 ${s.cpu.p50Ms.toFixed(2)}ms (encode ${s.encode.p50Ms.toFixed(2)}ms) · jank ${s.jank.longTasks} (${s.jank.longTaskMs.toFixed(0)}ms)`,
      );
      if (s.load) {
        console.log(`[perf] boot → first frame (once) ${s.load.total.toFixed(1)}ms · ${s.load.nodes} hierarchy nodes`);
        console.table(s.load.phases.map((p) => ({ phase: p.label, ms: +p.ms.toFixed(2) })));
      }
      if (s.add) {
        console.log(`[perf] last add-signal ${s.add.total.toFixed(1)}ms (${s.add.rows} rows)`);
        console.table(s.add.phases.map((p) => ({ phase: p.label, ms: +p.ms.toFixed(2) })));
      }
      if (s.swap) {
        console.log(`[perf] open VCD → first frame (each open) ${s.swap.total.toFixed(1)}ms (${s.swap.rows} rows)`);
        console.table(s.swap.phases.map((p) => ({ phase: p.label, ms: +p.ms.toFixed(2) })));
      }
      return s;
    },
  };
} catch { /* non-browser */ }
