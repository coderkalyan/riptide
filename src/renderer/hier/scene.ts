import type { Hierarchy, NodeId, Scope } from "./types";

export type Radix = "bin" | "hex" | "dec";
export type ActiveRole = "clock" | "reset" | "valid";

export interface ActiveSignalRef {
  signalId: NodeId;
  row: number;
  radix: Radix;
  color: string;
  pinned?: boolean;
  selected?: boolean;
  role?: ActiveRole;
  derivedExpr?: string;
}

interface SceneRef {
  handle: string;
  row: number;
  radix: Radix;
  color: string;
  pinned?: boolean;
  selected?: boolean;
  role?: ActiveRole;
  derivedExpr?: string;
}

// Handles must match tide.Signal.Id values assigned in native/src/mock_db.zig
// (Row enum 0..13). Native stringifies them; we reference the same strings.
const ACTIVE_BY_HANDLE: SceneRef[] = [
  { handle: "0",  row: 0,  radix: "bin", role: "clock", pinned: true,                color: "#72F5DF" },
  { handle: "1",  row: 1,  radix: "bin", role: "reset",                               color: "#F06B5B" },
  { handle: "2",  row: 2,  radix: "dec", selected: true,                              color: "#B48CFF" },
  { handle: "3",  row: 3,  radix: "dec",                                              color: "#B48CFF" },
  { handle: "4",  row: 4,  radix: "bin", role: "valid",                               color: "#F4A698" },
  { handle: "5",  row: 5,  radix: "hex",                                              color: "#F4A698" },
  { handle: "6",  row: 6,  radix: "hex",                                              color: "#F4A698" },
  { handle: "7",  row: 7,  radix: "bin", role: "valid",                               color: "#57C88A" },
  { handle: "8",  row: 8,  radix: "hex",                                              color: "#57C88A" },
  { handle: "9",  row: 9,  radix: "dec",                                              color: "#E6B14E" },
  { handle: "10", row: 10, radix: "bin",                                              color: "#E6B14E" },
  { handle: "11", row: 11, radix: "hex",                                              color: "#4FD2BD" },
  { handle: "12", row: 12, radix: "bin", derivedExpr: "in_valid | out_valid",         color: "#4FD2BD" },
  { handle: "13", row: 13, radix: "bin", derivedExpr: "state == DONE",                color: "#4FD2BD" },
];

const INITIAL_EXPANDED_PATHS: string[] = [
  "top",
  "top.keysched",
  "top.keysched.waves",
  "derived",
];

function lookupByHandle(h: Hierarchy, handle: string): NodeId {
  const ids = h.byHandle.get(handle);
  if (!ids || ids.length === 0) throw new Error(`Unknown signal handle: ${handle}`);
  return ids[0];
}

function lookupByPath(h: Hierarchy, path: string): NodeId {
  const parts = path.split(".");
  let candidates = h.rootIds;
  let found: NodeId | null = null;
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    found = null;
    for (const id of candidates) {
      const node = h.nodes.get(id);
      if (node && node.name === part) {
        found = id;
        break;
      }
    }
    if (found == null) throw new Error(`Path not found: ${path} (failed at "${part}")`);
    if (i + 1 < parts.length) {
      const node = h.nodes.get(found)!;
      if (node.kind !== "scope") throw new Error(`Path crosses non-scope: ${path}`);
      candidates = (node as Scope).children;
    }
  }
  return found!;
}

export function resolveScene(h: Hierarchy): {
  activeSignals: ActiveSignalRef[];
  initialExpanded: Set<NodeId>;
} {
  const activeSignals: ActiveSignalRef[] = ACTIVE_BY_HANDLE.map((r) => ({
    signalId: lookupByHandle(h, r.handle),
    row: r.row,
    radix: r.radix,
    color: r.color,
    pinned: r.pinned,
    selected: r.selected,
    role: r.role,
    derivedExpr: r.derivedExpr,
  }));
  const initialExpanded = new Set<NodeId>(
    INITIAL_EXPANDED_PATHS.map((p) => lookupByPath(h, p)),
  );
  return { activeSignals, initialExpanded };
}
