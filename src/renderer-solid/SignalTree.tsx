import { For, Show, createMemo } from "solid-js";
import { Dynamic } from "solid-js/web";
import { createVirtualizer } from "@tanstack/solid-virtual";
import { ChevronDown, ChevronRight, Package, Activity, Plus } from "lucide-solid";
import { SCENE } from "../renderer/hier/scene";
import type { NodeId, Scope, Signal } from "../renderer/hier/types";
import * as perf from "../renderer/perf";
import { useAppStore } from "./store/store";

const ROW_PX = 22; // .t-row height

function signalIconKind(sig: Signal): "enum" | "bus" | "scalar" {
  if (sig.enumTypeId != null) return "enum";
  if (sig.bitWidth > 1) return "bus";
  return "scalar";
}

interface FlatNode { id: NodeId; depth: number; kind: "scope" | "signal"; open: boolean }

// Depth-first walk of the hierarchy, descending into a scope only when it's
// expanded — the visible, flattened row list. Replaces the React recursive
// TreeNode + everOpened lazy-mount: virtualization only renders the on-screen
// window. (Plan trade-off: the per-scope height-expand animation is gone.)
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
  // traceNonce dep: re-run on an in-app trace swap even if expandedScopes content
  // happens to be unchanged (so the tree picks up the new SCENE.hierarchy).
  const flat = createMemo(() => {
    s.traceNonce;
    return flattenVisible(new Set(s.expandedScopes));
  });

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
        {/* <For> (reference-keyed) + a reactive flat()[index] lookup. virtual-core
            returns a STABLE measurement object per index, so on scroll For reuses
            the rows that stay visible (their entry memo doesn't re-run — flat is
            unchanged) and only adds/removes the few entering/leaving rows → cheap.
            On expand, flat() changes → every visible row's entry memo re-runs and
            its fine-grained bindings update in place (no stale/duplicate rows,
            which a non-reactive lookup would cause since the row is reused). */}
        <For each={virtualizer.getVirtualItems()}>{(vi) => {
          const entry = createMemo<FlatNode | undefined>(() => flat()[vi.index]);
          return (
            <Show when={entry()}>{(e) => {
              const node = createMemo(() => SCENE.hierarchy.nodes.get(e().id));
              const iconClass = () => {
                if (e().kind === "scope") return "icon module";
                const n = node();
                return `icon ${n && n.kind === "signal" ? signalIconKind(n) : "scalar"}`;
              };
              const onAdd = (ev: MouseEvent) => { ev.stopPropagation(); perf.beginAdd(); s.addSignal(e().id); };
              return (
                <div
                  class="t-row"
                  style={{
                    position: "absolute", top: 0, left: 0, width: "100%",
                    transform: `translateY(${vi.start}px)`,
                    "padding-left": e().depth > 0 ? `${4 + e().depth * 14}px` : undefined,
                  }}
                  onClick={() => { if (e().kind === "scope") s.toggleScope(e().id); }}
                >
                  <span class="chev">
                    {e().kind === "scope" ? (e().open ? <ChevronDown size={10} /> : <ChevronRight size={10} />) : null}
                  </span>
                  <span class={iconClass()}>
                    <Dynamic component={e().kind === "scope" ? Package : Activity} size={12} />
                  </span>
                  <span class="lbl">{node()?.name}</span>
                  <Show when={e().kind === "signal"}>
                    <span class="plus" data-tip="add to viewer" onClick={onAdd}><Plus size={12} /></span>
                  </Show>
                </div>
              );
            }}</Show>
          );
        }}</For>
      </div>
    </div>
  );
}
