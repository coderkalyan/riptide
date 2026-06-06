import type {
  Direction,
  Hierarchy,
  HierNode,
  NodeId,
  Scope,
  ScopeType,
  Signal,
  Timescale,
  VarType,
} from "./hier/types";
import { VCD_PATH } from "./runtime";
import { stamp } from "./perf";

declare const require: (m: string) => unknown;
declare const process: { platform: string } | undefined;

interface RawScopeNode {
  id: number;
  parent: number | null;
  name: string;
  kind: "scope";
  scopeType: ScopeType;
  children: number[];
}

interface RawSignalNode {
  id: number;
  parent: number | null;
  name: string;
  kind: "signal";
  varType: VarType;
  direction: Direction;
  bitWidth: number;
  handle: string;
}

type RawNode = RawScopeNode | RawSignalNode;

interface RawHierarchy {
  rootIds: number[];
  nodes: RawNode[];
  timescale: Timescale;
  endTicks: number;
}

// One row's packing request. The native side queries tide for `handle` over the
// full time range, then packs the resulting transitions into the GPU buffers.
export interface NativePackSpec {
  row: number;
  handle: string;
  kind: "clk" | "data";
  // Clock rows only: which edges get a chevron (ignored for data). Defaults to
  // "rising" on the renderer side when a row has no clock config yet.
  polarity: "rising" | "falling" | "both";
  shaded: boolean;
  gateHandle: string | null;
  // Multi-bit rows: how the native side formats the pill value label (label.zig).
  radix: "bin" | "hex" | "dec" | "sdec" | "enum";
  // Per-row enum int→label table (empty for non-enum rows). value = the integer
  // key the formatter matches against the low word of the sample.
  enums: { value: number; label: string }[];
}

interface NativeModule {
  loadVcd(path: string): void;
  getMockSegments(specs: NativePackSpec[], qStart: number, qEnd: number): {
    multi: ArrayBuffer;
    multiCount: number;
    single: ArrayBuffer;
    singleCount: number;
    rowInfo: ArrayBuffer;
    rowCount: number;
    x0Pool: ArrayBuffer;
    x1Pool: ArrayBuffer;
    labelBytes: ArrayBuffer;
    labelOffsets: ArrayBuffer;
    endTicks: number;
  };
  getHierarchy(): RawHierarchy;
  getValueAt(handle: string, tick: number): { lsb: number[]; msb: number[] } | null;
  getEdges(handle: string, startTick: number, count: number): {
    ticks: ArrayBuffer;
    lsb: ArrayBuffer;
    msb: ArrayBuffer;
    count: number;
  } | null;
}

stamp("native:require");
// The addon ships as one binary per platform under dist/native (both are bundled;
// only the host-matching one is ever require()d). Windows is a cross-compiled DLL
// (riptide-win.node, see scripts/gen-win-napi-shim.mjs); every other OS uses the
// native .so/.dylib (riptide.node). Two static specifiers so esbuild keeps both
// external (see build-ui.mjs); the ternary only evaluates the matching one.
const native = (
  (typeof process !== "undefined" && process.platform === "win32")
    ? require("../native/riptide-win.node")
    : require("../native/riptide.node")
) as NativeModule;

// Whether a trace has been loaded into the native db. False at boot when the
// window opened with no ?vcd= (idle app). While false every query function below
// short-circuits — the native db panics on a query with nothing loaded, and we
// want the backend to do nothing until the user opens a file.
let traceLoaded = false;
export function hasTrace(): boolean { return traceLoaded; }

// Swap the loaded trace at runtime (in-app "Open VCD…" — no window reload).
// getHierarchy/getMockSegments/getValueAt all query the current db after this.
export function loadVcd(path: string): void {
  native.loadVcd(path);
  traceLoaded = true;
}

// Load the initial trace named in the window URL before anything queries it
// (scene.ts builds SCENE at module load, which calls getHierarchy). With no
// ?vcd= the app boots idle and this is skipped — nothing touches the addon until
// an in-app "Open VCD…" calls loadVcd() via scene.ts swapTrace.
stamp("native:start");
if (VCD_PATH) loadVcd(VCD_PATH);
stamp("native:end");

// An empty pack result (no segments / rows / pools) for the no-trace idle state,
// so the GPU layer builds empty buffers and draws nothing without querying.
function emptyMockSegments(): NativeMockSegments {
  return {
    multi: new Uint32Array(0),
    multiCount: 0,
    single: new Uint32Array(0),
    singleCount: 0,
    rowInfo: new ArrayBuffer(0),
    rowCount: 0,
    x0Pool: new ArrayBuffer(0),
    x1Pool: new ArrayBuffer(0),
    labelBytes: new Uint8Array(0),
    labelOffsets: new Uint32Array(1), // multiCount+1 prefix offsets = [0]
    endTicks: 0,
  };
}

export interface NativeMockSegments {
  // 3×u32 PackedSegment records (t_start, t_end, row_flags) — values stripped
  // out into the shared pools below.
  multi: Uint32Array<ArrayBuffer>;
  multiCount: number;
  single: Uint32Array<ArrayBuffer>;
  singleCount: number;
  // 5×u32 RowInfo records, indexed by row, + the shared byte-stride value pools
  // (each sample = bytes_per_sample consecutive bytes — tide's native byte run,
  // memcpy'd straight in; bound as array<u32> on the GPU and byte-addressed).
  rowInfo: ArrayBuffer;
  rowCount: number;
  x0Pool: ArrayBuffer;
  x1Pool: ArrayBuffer;
  // Native value labels for the multi pipeline: concatenated ASCII bytes +
  // multiCount+1 prefix offsets aligned with `multi` (label i = bytes[off[i]..off[i+1]]).
  labelBytes: Uint8Array<ArrayBuffer>;
  labelOffsets: Uint32Array<ArrayBuffer>;
  // The trace's true end tick (native loaded.end_t) — used for viewport clamps
  // and the zoom-out dead-zone instead of a hardcoded mock end.
  endTicks: number;
}

// Pack the active signals over the tick window [qStart, qEnd] (the visible
// viewport plus the renderer's over-fetch margin). Repacked on every viewport
// change that exits the packed range; cost is O(window).
export function getMockSegments(
  specs: NativePackSpec[],
  qStart: number,
  qEnd: number,
): NativeMockSegments {
  if (!traceLoaded) return emptyMockSegments();
  const r = native.getMockSegments(specs, qStart, qEnd);
  return {
    multi: new Uint32Array(r.multi),
    multiCount: r.multiCount,
    single: new Uint32Array(r.single),
    singleCount: r.singleCount,
    rowInfo: r.rowInfo,
    rowCount: r.rowCount,
    x0Pool: r.x0Pool,
    x1Pool: r.x1Pool,
    labelBytes: new Uint8Array(r.labelBytes),
    labelOffsets: new Uint32Array(r.labelOffsets),
    endTicks: r.endTicks,
  };
}

// Decoded (lsb, msb) of a signal at a tick — the CPU-side value lookup that
// replaces scanning a JS segment list. lsb/msb are little-endian u32 word arrays
// (one word per 32 bits of declared width), so signals wider than 32 bits are
// carried in full. Returns null off the end of the trace.
export function getValueAt(handle: string, tick: number): { lsb: number[]; msb: number[] } | null {
  if (!traceLoaded) return null;
  return native.getValueAt(handle, tick);
}

// Up to `count` transitions of a signal at/after `startTick`. Each transition
// carries its tick + the low byte of the (lsb, msb) logic planes — enough to
// decode 1-bit clock/reset levels. Used for cheap prefix detection of a clock's
// period/phase and a reset's held interval (see wave/clock.ts). Null if the
// handle is unknown.
export interface NativeEdges {
  // f64 ticks (full u64 range, exact to 2^53) — see getEdges in native/src/main.zig.
  ticks: Float64Array<ArrayBuffer>;
  lsb: Uint8Array<ArrayBuffer>;
  msb: Uint8Array<ArrayBuffer>;
  count: number;
}
export function getEdges(handle: string, startTick: number, count: number): NativeEdges | null {
  if (!traceLoaded) return null;
  const r = native.getEdges(handle, startTick, count);
  if (!r) return null;
  return {
    ticks: new Float64Array(r.ticks),
    lsb: new Uint8Array(r.lsb),
    msb: new Uint8Array(r.msb),
    count: r.count,
  };
}

export function getHierarchy(): Hierarchy {
  const raw = native.getHierarchy();
  const nodes = new Map<NodeId, HierNode>();
  const byHandle = new Map<string, NodeId[]>();
  for (const n of raw.nodes) {
    if (n.kind === "scope") {
      const scope: Scope = {
        kind: "scope",
        id: n.id,
        parent: n.parent,
        name: n.name,
        scopeType: n.scopeType,
        children: n.children,
      };
      nodes.set(n.id, scope);
    } else {
      const sig: Signal = {
        kind: "signal",
        id: n.id,
        parent: n.parent ?? 0,
        name: n.name,
        varType: n.varType,
        direction: n.direction,
        bitWidth: n.bitWidth,
        handle: n.handle,
      };
      nodes.set(n.id, sig);
      const arr = byHandle.get(sig.handle);
      if (arr) arr.push(n.id);
      else byHandle.set(sig.handle, [n.id]);
    }
  }
  // enumTypes is left empty here; mock enum metadata is overlaid in hier/scene.ts
  // (tide's hierarchy schema doesn't carry enum members yet — see README).
  return {
    nodes,
    rootIds: raw.rootIds,
    byHandle,
    enumTypes: new Map(),
    timescale: raw.timescale,
    endTicks: raw.endTicks,
  };
}
