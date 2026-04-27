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
  format: Hierarchy["format"];
  timescale: Timescale;
}

interface NativeModule {
  getMockSegments(): {
    multi: ArrayBuffer;
    multiCount: number;
    single: ArrayBuffer;
    singleCount: number;
  };
  getHierarchy(): RawHierarchy;
}

const native = require("../native/riptide.node") as NativeModule;

export interface NativeMockSegments {
  multi: Uint32Array<ArrayBuffer>;
  multiCount: number;
  single: Uint32Array<ArrayBuffer>;
  singleCount: number;
}

export function getMockSegments(): NativeMockSegments {
  const r = native.getMockSegments();
  return {
    multi: new Uint32Array(r.multi),
    multiCount: r.multiCount,
    single: new Uint32Array(r.single),
    singleCount: r.singleCount,
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
  return {
    nodes,
    rootIds: raw.rootIds,
    byHandle,
    enumTypes: new Map(),
    format: raw.format,
    timescale: raw.timescale,
  };
}
