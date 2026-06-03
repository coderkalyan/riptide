import { For, createMemo } from "solid-js";
import { createVirtualizer } from "@tanstack/solid-virtual";
import { ChevronDown, ChevronRight, Package, Activity, Plus } from "lucide-solid";
import { SCENE } from "../renderer/hier/scene";
import type { NodeId, Scope, Signal } from "../renderer/hier/types";
import { useAppStore } from "./store/store";

const ROW_PX = 22; // .t-row height

function signalIconKind(sig: Signal): "enum" | "bus" | "scalar" {
  if (sig.enumTypeId != null) return "enum";
  if (sig.bitWidth > 1) return "bus";
  return "scalar";
}

interface FlatNode { id: NodeId; depth: number; kind: "scope" | "signal"; open: boolean }

// Depth-first walk of the hierarchy, descending into a scope only when it's
// expanded — the visible, flattened row list. This replaces the React recursive
// TreeNode + everOpened lazy-mount: virtualization only renders the on-screen
// window, so a huge expanded tree never mounts in full. (Trade-off accepted in
// the plan: the per-scope 0fr↔1fr height-expand animation is gone — expand /
// collapse is instant.)
function flattenVisible(expanded: Set<NodeId>): FlatNode[] {
  const h = SCENE.hierarchy;
  const out: FlatNode[] = [];
  const walk = (id: NodeId, depth: number) => {
    const node = h.nodes.get(id);
    if (!node) return;
    const open = node.kind === "scope" && expanded.has(id);
    out.push({ id, depth, kind: node.kind, open });
    if (node.kind === "scope" && open) {
      for (const c of (node as Scope).children) walk(c, depth + 1);
    }
  };
  for (const id of h.rootIds) walk(id, 0);
  return out;
}

export function SignalTree() {
  const s = useAppStore();
  const flat = createMemo(() => flattenVisible(new Set(s.expandedScopes)));

  let scrollEl: HTMLDivElement | undefined;
  const virtualizer = createVirtualizer({
    get count() { return flat().length; },
    getScrollElement: () => scrollEl ?? null,
    estimateSize: () => ROW_PX,
    overscan: 12,
  });

  return (
    <div class="tree" ref={scrollEl}>
      <div style={{ position: "relative", width: "100%", height: `${virtualizer.getTotalSize()}px` }}>
        <For each={virtualizer.getVirtualItems()}>{(vi) => {
          const entry = flat()[vi.index];
          if (!entry) return null;
          const node = SCENE.hierarchy.nodes.get(entry.id)!;
          const indent = entry.depth > 0 ? { "padding-left": `${4 + entry.depth * 14}px` } : undefined;
          return (
            <div style={{ position: "absolute", top: 0, left: 0, width: "100%", transform: `translateY(${vi.start}px)` }}>
              {entry.kind === "scope" ? (
                <div class="t-row" style={indent} onClick={() => s.toggleScope(entry.id)}>
                  <span class="chev">{entry.open ? <ChevronDown size={10} /> : <ChevronRight size={10} />}</span>
                  <span class="icon module"><Package size={12} /></span>
                  <span class="lbl">{node.name}</span>
                </div>
              ) : (
                <div class="t-row" style={indent}>
                  <span class="chev" />
                  <span class={`icon ${signalIconKind(node as Signal)}`}><Activity size={12} /></span>
                  <span class="lbl">{node.name}</span>
                  <span
                    class="plus"
                    data-tip="add to viewer"
                    onClick={(e) => { e.stopPropagation(); s.addSignal(entry.id); }}
                  ><Plus size={12} /></span>
                </div>
              )}
            </div>
          );
        }}</For>
      </div>
    </div>
  );
}
