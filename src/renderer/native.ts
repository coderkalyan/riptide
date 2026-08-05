import type {
  Direction,
  EnumType,
  HierNode,
  Hierarchy,
  NodeId,
  Scope,
  ScopeType,
  Signal,
  SourceLoc,
  Timescale,
  VarType,
} from "./hier/types";
import { VCD_PATH } from "./runtime";
import { stamp } from "./perf";

declare const require: (m: string) => unknown;

interface RawScopeNode {
  id: number;
  parent: number | null;
  name: string;
  kind: "scope";
  scopeType: ScopeType;
  children: number[];
  // Present only when an SDI file sits beside the trace (see native/src/design.rs).
  declSourceLoc?: SourceLoc;
  instSourceLoc?: SourceLoc;
  comment?: string;
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
  supported: boolean;
  // SDI-only, as above.
  typeName?: string;
  range?: { msb: number; lsb: number };
  enumTypeId?: number;
  sourceLoc?: SourceLoc;
  comment?: string;
  hintRole?: "clock" | "reset" | "valid";
}

type RawNode = RawScopeNode | RawSignalNode;

interface RawHierarchy {
  rootIds: number[];
  nodes: RawNode[];
  /// Enum int→label tables from the SDI; empty without one.
  enumTypes: EnumType[];
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
  // Handle of a 1-bit enable signal that mutes this row while it isn't logic-1
  // (null = no muting). Resolved from the row's sidecar `mute` path.
  muteHandle: string | null;
  // How the native side formats the value label (label.rs). bin = no label
  // (single line); boolean = single line + true/false label; the rest are pills.
  radix: "bin" | "hex" | "dec" | "sdec" | "enum" | "boolean";
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
    singleLabelBytes: ArrayBuffer;
    singleLabelOffsets: ArrayBuffer;
    endTicks: number;
  };
  getHierarchy(): RawHierarchy;
  getValueAt(handle: string, tick: number): { lsb: number[]; msb: number[]; z: number[] } | null;
  getEdges(handle: string, startTick: number, count: number): {
    ticks: ArrayBuffer;
    lsb: ArrayBuffer;
    msb: ArrayBuffer;
    count: number;
  } | null;
  searchTree(query: string): Promise<NativeTreeRows>;
  markStrings(candidates: string[], query: string): NativeStringMarks;
}

// Parallel buffers as search.rs / hierarchy.rs pack them; decoded below.
interface NativeTreeRows {
  ids: ArrayBuffer;
  depths: ArrayBuffer;
  matched: ArrayBuffer;
  total: number;
}

interface NativeStringMarks {
  matched: ArrayBuffer;
  ranges: ArrayBuffer;
  rangeCounts: ArrayBuffer;
  leafOffsets: ArrayBuffer;
}

stamp("native:require");
// The addon is built per platform to a single canonical name under dist/native
// (the build orchestrator maps .so/.dylib/.dll → riptide.node — see
// scripts/build.mjs). An installer only ever carries its own platform's binary,
// so one specifier suffices; esbuild keeps it external (see build-ui.mjs).
const native = require("../native/riptide.node") as NativeModule;

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
    singleLabelBytes: new Uint8Array(0),
    singleLabelOffsets: new Uint32Array(1), // singleCount+1 prefix offsets = [0]
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
  // Native value labels for the single pipeline: same layout, aligned with
  // `single`. Only boolean rows carry text ("true"/"false"/"x"); bin/clock/reset
  // segments carry empty labels (so label i still aligns with single segment i).
  singleLabelBytes: Uint8Array<ArrayBuffer>;
  singleLabelOffsets: Uint32Array<ArrayBuffer>;
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
    singleLabelBytes: new Uint8Array(r.singleLabelBytes),
    singleLabelOffsets: new Uint32Array(r.singleLabelOffsets),
    endTicks: r.endTicks,
  };
}

// Decoded planes of a signal at a tick — the CPU-side value lookup that
// replaces scanning a JS segment list. lsb (value, unknowns read as 0), msb
// (unknown mask) and z (high impedance) are little-endian u32 word arrays
// (one word per 32 bits of declared width), so signals wider than 32 bits are
// carried in full. Returns null off the end of the trace.
export function getValueAt(
  handle: string,
  tick: number,
): { lsb: number[]; msb: number[]; z: number[] } | null {
  if (!traceLoaded) return null;
  return native.getValueAt(handle, tick);
}

// Up to `count` transitions of a signal at/after `startTick`. Each transition
// carries its tick + the low byte of the (lsb, msb) logic planes — enough to
// decode 1-bit clock/reset levels. Used for cheap prefix detection of a clock's
// period/phase and a reset's held interval (see wave/clock.ts). Null if the
// handle is unknown.
export interface NativeEdges {
  // f64 ticks (full u64 range, exact to 2^53) — see getEdges in native/src/lib.rs.
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
      if (n.declSourceLoc) scope.declSourceLoc = n.declSourceLoc;
      if (n.instSourceLoc) scope.instSourceLoc = n.instSourceLoc;
      if (n.comment) scope.comment = n.comment;
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
        supported: n.supported,
      };
      // Source debug info, when the trace has an SDI beside it. Absent fields stay
      // absent rather than becoming undefined-valued keys.
      if (n.typeName) sig.typeName = n.typeName;
      if (n.range) sig.range = n.range;
      if (n.enumTypeId != null) sig.enumTypeId = n.enumTypeId;
      if (n.sourceLoc) sig.sourceLoc = n.sourceLoc;
      if (n.comment) sig.comment = n.comment;
      if (n.hintRole) sig.hintRole = n.hintRole;
      nodes.set(n.id, sig);
      const arr = byHandle.get(sig.handle);
      if (arr) arr.push(n.id);
      else byHandle.set(sig.handle, [n.id]);
    }
  }
  return {
    nodes,
    rootIds: raw.rootIds,
    byHandle,
    enumTypes: new Map((raw.enumTypes ?? []).map((t) => [t.id, t])),
    timescale: raw.timescale,
    endTicks: raw.endTicks,
  };
}

// ---- fuzzy search --------------------------------------------------------

// The signal tree pruned to a query: one entry per visible row, in tree order —
// every node that matched plus the scopes above it, which render opened.
// `matched[i]` distinguishes a hit from a scope on the way to one; `total` counts
// the hits.
export interface TreeRows {
  ids: Uint32Array;
  depths: Uint32Array;
  matched: Uint8Array;
  total: number;
}

// Match flags + highlight offsets for a candidate list, positionally parallel to
// it. `matched[i]` is every query term matching (what a filter keeps);
// `ranges[i]` is (start, len) pairs of matched characters for the terms that *did*
// match, as UTF-16 offsets ready to slice a JS string with (what a highlight
// draws). `leafOffsets[i]` is where the candidate's last path segment starts, for
// a consumer that renders only the leaf name.
export interface StringMarks {
  matched: boolean[];
  ranges: number[][];
  leafOffsets: number[];
}

const NO_ROWS: TreeRows = { ids: new Uint32Array(0), depths: new Uint32Array(0), matched: new Uint8Array(0), total: 0 };
const NO_MARKS: StringMarks = { matched: [], ranges: [], leafOffsets: [] };

// The hierarchy pruned to `query`. Async: the scan and the prune are each linear
// in a hierarchy that can hold a million nodes, and they run per keystroke, so
// they stay off the thread driving the render loop. A blank query resolves empty —
// callers show the unfiltered tree instead of asking.
export async function searchTree(query: string): Promise<TreeRows> {
  if (!traceLoaded || !query.trim()) return NO_ROWS;
  const raw = await native.searchTree(query);
  return {
    ids: new Uint32Array(raw.ids),
    depths: new Uint32Array(raw.depths),
    matched: new Uint8Array(raw.matched),
    total: raw.total,
  };
}

// The same matcher over a caller-supplied list. Synchronous because the caller
// bounds it — the active rows, or the handful of tree rows on screen — and it
// takes strings because not every candidate is a node: an active row may be a
// derived signal, and a tree row is highlighted against its own name.
export function markStrings(candidates: string[], query: string): StringMarks {
  if (!candidates.length || !query.trim()) return NO_MARKS;
  const raw = native.markStrings(candidates, query);
  const matchedBytes = new Uint8Array(raw.matched);
  const counts = new Uint32Array(raw.rangeCounts);
  const leaves = new Uint32Array(raw.leafOffsets);
  const ranges = new Uint32Array(raw.ranges);
  const out: StringMarks = { matched: new Array(candidates.length), ranges: new Array(candidates.length), leafOffsets: new Array(candidates.length) };
  let at = 0;
  for (let i = 0; i < candidates.length; i++) {
    const span = counts[i] * 2;
    out.matched[i] = matchedBytes[i] === 1;
    out.ranges[i] = Array.from(ranges.subarray(at, at + span));
    out.leafOffsets[i] = leaves[i];
    at += span;
  }
  return out;
}
