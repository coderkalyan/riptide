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
}

// One row's packing request. The native side queries tide for `handle` over the
// full time range, then packs the resulting transitions into the GPU buffers.
export interface NativePackSpec {
  row: number;
  handle: string;
  kind: "clk" | "data";
  shaded: boolean;
  gateHandle: string | null;
}

interface NativeModule {
  loadVcd(path: string): void;
  getMockSegments(specs: NativePackSpec[]): {
    multi: ArrayBuffer;
    multiCount: number;
    single: ArrayBuffer;
    singleCount: number;
    rowInfo: ArrayBuffer;
    rowCount: number;
    x0Pool: ArrayBuffer;
    x1Pool: ArrayBuffer;
  };
  getHierarchy(): RawHierarchy;
  getValueAt(handle: string, tick: number): { lsb: number[]; msb: number[] } | null;
}

stamp("native:require");
const native = require("../native/riptide.node") as NativeModule;

// Swap the loaded trace at runtime (in-app "Open VCD…" — no window reload).
// getHierarchy/getMockSegments/getValueAt all query the current db after this.
export function loadVcd(path: string): void {
  native.loadVcd(path);
}

// Load the initial trace named in the window URL before anything queries it
// (scene.ts builds SCENE at module load, which calls getHierarchy). Later "Open
// VCD…" picks call loadVcd() again via scene.ts swapTrace to swap the db in place.
stamp("native:start");
if (VCD_PATH) native.loadVcd(VCD_PATH);
stamp("native:end");

export interface NativeMockSegments {
  // 3×u32 PackedSegment records (t_start, t_end, row_flags) — values stripped
  // out into the shared pools below.
  multi: Uint32Array<ArrayBuffer>;
  multiCount: number;
  single: Uint32Array<ArrayBuffer>;
  singleCount: number;
  // 5×u32 RowInfo records, indexed by row, + the shared word-stride value pools
  // (each sample = words_per_sample consecutive u32 words, full declared width).
  rowInfo: ArrayBuffer;
  rowCount: number;
  x0Pool: ArrayBuffer;
  x1Pool: ArrayBuffer;
}

export function getMockSegments(specs: NativePackSpec[]): NativeMockSegments {
  const r = native.getMockSegments(specs);
  return {
    multi: new Uint32Array(r.multi),
    multiCount: r.multiCount,
    single: new Uint32Array(r.single),
    singleCount: r.singleCount,
    rowInfo: r.rowInfo,
    rowCount: r.rowCount,
    x0Pool: r.x0Pool,
    x1Pool: r.x1Pool,
  };
}

// Decoded (lsb, msb) of a signal at a tick — the CPU-side value lookup that
// replaces scanning a JS segment list. lsb/msb are little-endian u32 word arrays
// (one word per 32 bits of declared width), so signals wider than 32 bits are
// carried in full. Returns null off the end of the trace.
export function getValueAt(handle: string, tick: number): { lsb: number[]; msb: number[] } | null {
  return native.getValueAt(handle, tick);
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
  };
}
