import { createSignal, createMemo, onCleanup } from "solid-js";
import { Key } from "@solid-primitives/keyed";
import { createVirtualizer } from "@tanstack/solid-virtual";
import { ChevronRight, Package, Activity, Plus } from "lucide-solid";
import { SCENE } from "./hier/scene";
import type { NodeId, Scope, Signal } from "./hier/types";
import * as perf from "./perf";
import { useAppStore } from "./store/store";

const ROW_PX = 22; // .t-row height
// Slide eases the row to its new index; the revealed children stay invisible
// while the gap opens (opacity delayed past most of the slide) then fade in — so
// no row ever slides over visible content.
const ROW_TRANSITION = "transform 0.18s ease, opacity 0.15s ease 0.1s";

function signalIconKind(sig: Signal): "enum" | "bus" | "scalar" {
  if (sig.enumTypeId != null) return "enum";
  if (sig.bitWidth > 1) return "bus";
  return "scalar";
}

interface FlatNode { id: NodeId; depth: number; kind: "scope" | "signal"; open: boolean }

// Depth-first walk; descend into a scope only when expanded — the visible flat row list.
function flattenVisible(expanded: Set<NodeId>): FlatNode[] {
  const h = SCENE.hierarchy;
  const out: FlatNode[] = [];
  const walk = (id: NodeId, depth: number) => {
    const node = h.nodes.get(id);
    if (!node) return;
    const open = node.kind === "scope" && expanded.has(id);
    out.push({ id, depth, kind: node.kind, open });
    if (node.kind === "scope" && open) for (const c of (node as Scope).children) walk(c, depth + 1);
  };
  for (const id of h.rootIds) walk(id, 0);
  return out;
}

// Virtualized tree (only the on-screen window renders) with an expand/collapse
// SLIDE animation. Keyed by node id (<Key>) and absolutely positioned at
// translateY(index * ROW_PX) with a transform transition:
//   - Scroll is native (scrollTop) → a node's index/translateY is unchanged, so
//     the transition never fires while scrolling.
//   - Expand/collapse shifts a node's index → its row slides to the new spot.
//     Rows below the toggled scope slide down/up; the revealed children fade into
//     the opened gap (invisible during the slide so nothing slides over them).
// The fade is gated to expand (an `expanding` pulse) so scrolling new rows into
// view doesn't shimmer.
export function SignalTree() {
  const s = useAppStore();
  const flat = createMemo<FlatNode[]>(() => { s.traceNonce; return flattenVisible(new Set(s.expandedScopes)); });

  // True for the duration of an expand so freshly-mounted rows fade in; off
  // during scroll so scroll-in rows appear instantly.
  const [expanding, setExpanding] = createSignal(false);
  let expandTimer: number | undefined;
  const pulseExpand = () => {
    setExpanding(true);
    clearTimeout(expandTimer);
    expandTimer = window.setTimeout(() => setExpanding(false), 360);
  };
  onCleanup(() => clearTimeout(expandTimer));

  let scrollEl: HTMLDivElement | undefined;
  const virtualizer = createVirtualizer({
    get count() { return flat().length; },
    getScrollElement: () => scrollEl ?? null,
    estimateSize: () => ROW_PX,
    overscan: 12,
  });

  const windowNodes = createMemo(() =>
    virtualizer.getVirtualItems()
      .map((vi) => ({ node: flat()[vi.index] as FlatNode | undefined, start: vi.start }))
      .filter((w): w is { node: FlatNode; start: number } => !!w.node));

  return (
    <div class="tree" ref={scrollEl}>
      <div style={{ position: "relative", width: "100%", height: `${virtualizer.getTotalSize()}px` }}>
        <Key each={windowNodes()} by={(w) => w.node.id}>{(item) => {
          const e = () => item().node;
          const node = createMemo(() => { s.traceNonce; return SCENE.hierarchy.nodes.get(e().id); });
          // Immediate (non-recursive) signal children of a scope — the set the
          // scope's plus button adds. Empty for signal rows / signal-less scopes.
          const sigChildren = createMemo<NodeId[]>(() => {
            const n = node();
            if (!n || n.kind !== "scope") return [];
            // Only addable (supported) signals — real/string/no-sample children are
            // excluded so "add all in scope" never adds an un-renderable signal.
            return n.children.filter((c) => {
              const cn = SCENE.hierarchy.nodes.get(c);
              return cn?.kind === "signal" && cn.supported;
            });
          });
          // A signal row is addable only if tide ingested data for it (Signal.
          // supported). Unsupported rows render dimmed + non-addable with a tip.
          const supported = createMemo(() => {
            const n = node();
            return !(n && n.kind === "signal" && !n.supported);
          });
          const iconClass = () => {
            if (e().kind === "scope") return "icon module";
            const n = node();
            return `icon ${n && n.kind === "signal" ? signalIconKind(n) : "scalar"}`;
          };
          // Fade in only when this row mounts as part of an expand (not scroll).
          const [op, setOp] = createSignal(expanding() ? 0 : 1);
          if (expanding()) requestAnimationFrame(() => setOp(1));
          return (
            <div
              class={"t-row" + (supported() ? "" : " unsupported")}
              data-tip={supported() ? undefined : "unsupported type (real/string or no samples) — can't be displayed"}
              style={{
                position: "absolute", top: 0, left: 0, width: "100%",
                transform: `translateY(${item().start}px)`,
                opacity: op(),
                transition: ROW_TRANSITION,
                "padding-left": e().depth > 0 ? `${4 + e().depth * 14}px` : undefined,
              }}
              onClick={() => { if (e().kind === "scope") { pulseExpand(); s.toggleScope(e().id); } }}
            >
              <span
                class="chev"
                style={e().kind === "scope" ? {
                  transform: e().open ? "rotate(90deg)" : "rotate(0deg)",
                  transition: "transform 0.18s ease",
                } : undefined}
              >
                {e().kind === "scope" ? <ChevronRight size={10} /> : null}
              </span>
              <span class={iconClass()}>{e().kind === "scope" ? <Package size={12} /> : <Activity size={12} />}</span>
              <span class="lbl">{node()?.name}</span>
              {e().kind === "signal" ? (
                supported() ? (
                  <span
                    class="plus"
                    data-tip="add to viewer"
                    onClick={(ev) => { ev.stopPropagation(); perf.beginAdd(); s.addSignal(e().id); }}
                  ><Plus size={12} /></span>
                ) : null
              ) : sigChildren().length > 0 ? (
                <span
                  class="plus"
                  data-tip="add all signals in scope"
                  onClick={(ev) => { ev.stopPropagation(); perf.beginAdd(); s.addSignals(sigChildren()); }}
                ><Plus size={12} /></span>
              ) : null}
            </div>
          );
        }}</Key>
      </div>
    </div>
  );
}
