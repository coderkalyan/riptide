// HierarchyDto (bridge.getHierarchy) → renderer Hierarchy map. Mirrors the
// marshalling in native.ts getHierarchy — the DTO is shape-identical to the
// addon's RawHierarchy — but deliberately does NOT import native.ts (whose
// module body require()s the napi addon; in the Tauri bundle it is aliased to
// tauri/nativeStub.ts anyway).

import type { HierarchyDto } from "../ipc/types";
import type {
  Direction,
  Hierarchy,
  HierNode,
  NodeId,
  Scope,
  ScopeType,
  Signal,
  Timescale,
  TimeUnit,
  VarType,
} from "../hier/types";

export function marshalHierarchy(raw: HierarchyDto): Hierarchy {
  const nodes = new Map<NodeId, HierNode>();
  const byHandle = new Map<string, NodeId[]>();
  for (const n of raw.nodes) {
    if (n.kind === "scope") {
      const scope: Scope = {
        kind: "scope",
        id: n.id,
        parent: n.parent,
        name: n.name,
        scopeType: n.scopeType as ScopeType,
        children: n.children,
      };
      nodes.set(n.id, scope);
    } else {
      const sig: Signal = {
        kind: "signal",
        id: n.id,
        parent: n.parent ?? 0,
        name: n.name,
        varType: n.varType as VarType,
        direction: n.direction as Direction,
        bitWidth: n.bitWidth,
        handle: n.handle,
      };
      nodes.set(n.id, sig);
      const arr = byHandle.get(sig.handle);
      if (arr) arr.push(n.id);
      else byHandle.set(sig.handle, [n.id]);
    }
  }
  const timescale: Timescale = {
    value: raw.timescale.value,
    unit: raw.timescale.unit as TimeUnit,
  };
  // enumTypes left empty — same as native.ts (mock enum metadata is overlaid in
  // hier/scene.ts; the trace hierarchy doesn't carry enum members yet).
  return {
    nodes,
    rootIds: raw.rootIds,
    byHandle,
    enumTypes: new Map(),
    timescale,
    endTicks: raw.endTicks,
  };
}
