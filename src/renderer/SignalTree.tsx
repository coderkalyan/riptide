import { For, Show, createEffect, createMemo, createResource, createSignal, on, onCleanup } from "solid-js";
import { Key } from "@solid-primitives/keyed";
import { createVirtualizer } from "@tanstack/solid-virtual";
import { ChevronRight, Package, Activity, Plus, X } from "lucide-solid";
import { SCENE } from "./hier/scene";
import { pathOf } from "./hier/types";
import type { NodeId, Scope, Signal } from "./hier/types";
import { markStrings, searchTree } from "./native";
import { Highlight } from "./highlight";
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

// Immediate (non-recursive) addable signal children of a scope — the set the
// scope's plus button / a selected scope adds. Only supported (tide-ingested)
// signals; real/string/no-sample children are excluded so "add scope" never adds
// an un-renderable signal. Empty for signal ids / signal-less scopes.
export function immediateSigChildren(id: NodeId): NodeId[] {
  const n = SCENE.hierarchy.nodes.get(id);
  if (!n || n.kind !== "scope") return [];
  return (n as Scope).children.filter((c) => {
    const cn = SCENE.hierarchy.nodes.get(c);
    return cn?.kind === "signal" && cn.supported;
  });
}

// All supported signal descendants of a scope, depth-first (the "Add recursive"
// set). Signals pass through as themselves.
export function recursiveSigChildren(id: NodeId): NodeId[] {
  const h = SCENE.hierarchy;
  const out: NodeId[] = [];
  const walk = (nid: NodeId) => {
    const n = h.nodes.get(nid);
    if (!n) return;
    if (n.kind === "signal") { if (n.supported) out.push(nid); return; }
    for (const c of (n as Scope).children) walk(c);
  };
  walk(id);
  return out;
}

// Resolve a tree selection (scopes + signals) into the concrete signal ids to add.
// Signals pass through (supported only); scopes expand to their IMMEDIATE supported
// signals (matches the scope plus button). NOT deduped — re-adding is intentional.
export function resolveAddIds(selection: NodeId[]): NodeId[] {
  const out: NodeId[] = [];
  for (const id of selection) {
    const n = SCENE.hierarchy.nodes.get(id);
    if (!n) continue;
    if (n.kind === "signal") { if (n.supported) out.push(id); }
    else out.push(...immediateSigChildren(id));
  }
  return out;
}

// Every scope id in the hierarchy — for Expand All.
export function allScopeIds(): NodeId[] {
  const h = SCENE.hierarchy;
  const out: NodeId[] = [];
  for (const [id, n] of h.nodes) if (n.kind === "scope") out.push(id);
  return out;
}

// `matched` is set only while a filter is live: the row list is then the pruned
// tree, in which a row either matched the query itself or is a scope kept open
// above one.
interface FlatNode { id: NodeId; depth: number; kind: "scope" | "signal"; open: boolean; matched?: boolean }

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

// Every scope from a node up to its root — what has to be open for the node to
// be visible in the tree ("reveal" out of a search result).
function ancestorScopes(id: NodeId): NodeId[] {
  const h = SCENE.hierarchy;
  const out: NodeId[] = [];
  let cursor = h.nodes.get(id)?.parent ?? null;
  while (cursor != null) {
    out.push(cursor);
    cursor = h.nodes.get(cursor)?.parent ?? null;
  }
  return out;
}

// The tree's filter input, so Edit ▸ Find… / Ctrl+F can reach it from outside.
// Undefined while the panel is collapsed and the tree unmounted.
let searchEl: HTMLInputElement | undefined;

// Focus (and select) the filter box. A no-op if the panel is collapsed, so
// callers expand it first.
export function focusTreeSearch() {
  searchEl?.focus();
  searchEl?.select();
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
//
// With a query in the filter box the tree switches to a flat ranked result list:
// ranking is meaningless in a pruned tree (it would be forced back into tree
// order), and auto-expanding matched scopes would have to write `expandedScopes`,
// which the sidecar persists — a search would quietly rewrite the saved view.
// Double-clicking a matched scope reveals it in the tree instead.
//
// Multi-select: a row click selects its node (scope or signal); a scope's chevron
// (not its body) toggles expand. Shift-range spans the flat-visible order; ctrl/meta
// toggles. The plus button adds the whole selection when the row is in it, else just
// that row. Enter adds the selection; Esc clears it.
export function SignalTree() {
  const s = useAppStore();

  // Filtering runs natively on a worker thread, so a keystroke never competes
  // with the render loop. createResource keeps only the newest answer: a slower
  // earlier query resolving late is discarded rather than flashing stale rows.
  const [found] = createResource(
    () => [s.treeQuery.trim(), s.traceNonce] as const,
    ([query]) => searchTree(query),
  );
  const searching = () => s.treeQuery.trim().length > 0;
  const matchLabel = () => {
    const total = found.latest?.total ?? 0;
    return `${total} match${total === 1 ? "" : "es"}`;
  };

  // Filtered, the rows are the pruned tree the native side returned: the matches
  // plus the scopes above them, already in tree order and every one of them shown
  // open. Unfiltered, it is the usual walk of what the user has expanded — the
  // filter never touches `expandedScopes`, which the sidecar persists.
  const flat = createMemo<FlatNode[]>(() => {
    s.traceNonce;
    if (!searching()) return flattenVisible(new Set(s.expandedScopes));
    const rows = found.latest;
    if (!rows) return [];
    const h = SCENE.hierarchy;
    const out: FlatNode[] = [];
    for (let i = 0; i < rows.ids.length; i++) {
      const node = h.nodes.get(rows.ids[i]);
      if (node) {
        out.push({ id: rows.ids[i], depth: rows.depths[i], kind: node.kind, open: true, matched: rows.matched[i] === 1 });
      }
    }
    return out;
  });

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

  const selected = createMemo(() => new Set(s.treeSelection));
  const select = (id: NodeId, ev: MouseEvent) =>
    s.selectTreeNode(id, { ctrl: ev.ctrlKey || ev.metaKey, shift: ev.shiftKey }, flat().map((f) => f.id));
  const addSelection = () => {
    const ids = resolveAddIds(useAppStore.getState().treeSelection);
    if (ids.length) { perf.beginAdd(); s.addSignals(ids); }
  };

  let scrollEl: HTMLDivElement | undefined;
  const virtualizer = createVirtualizer({
    get count() { return flat().length; },
    getScrollElement: () => scrollEl ?? null,
    estimateSize: () => ROW_PX,
    overscan: 12,
  });

  const windowNodes = createMemo(() =>
    virtualizer.getVirtualItems()
      .map((vi) => ({ node: flat()[vi.index] as FlatNode | undefined, start: vi.start, idx: vi.index }))
      .filter((w): w is { node: FlatNode; start: number; idx: number } => !!w.node));

  // Highlight offsets for the rows actually on screen, matched against their own
  // names. Bounded by the virtualizer window, so this is the sync call: a few
  // dozen short strings, and it reuses the one matcher rather than reimplementing
  // it here. A name may hold only some of the query's terms — the `clk` of
  // `hart clk` — and each one it does hold still marks.
  const windowRanges = createMemo<Map<NodeId, number[]>>(() => {
    const out = new Map<NodeId, number[]>();
    if (!searching()) return out;
    const rows = windowNodes();
    const h = SCENE.hierarchy;
    const names = rows.map((row) => h.nodes.get(row.node.id)?.name ?? "");
    const marks = markStrings(names, s.treeQuery);
    for (let i = 0; i < rows.length; i++) {
      const ranges = marks.ranges[i];
      if (ranges && ranges.length) out.set(rows[i].node.id, ranges);
    }
    return out;
  });

  // Leave the results and show `id` where it lives: open every scope above it,
  // clear the query, select it, and scroll it into view — a reveal that leaves the
  // node off-screen has revealed nothing. The scroll waits a frame because the
  // virtualizer has to see the re-expanded row count first.
  const reveal = (id: NodeId) => {
    const open = new Set(s.expandedScopes);
    for (const scope of ancestorScopes(id)) open.add(scope);
    s.setExpanded([...open]);
    s.setTreeQuery("");
    s.setTreeSelection([id]);
    requestAnimationFrame(() => {
      const index = flat().findIndex((node) => node.id === id);
      if (index >= 0) virtualizer.scrollToIndex(index, { align: "center" });
    });
  };

  // A new query means a new result list: start it at the top. Clearing the query
  // is left alone — the tree returns to where it was, and a reveal has its own
  // scroll to do.
  createEffect(on(() => s.treeQuery, (query) => { if (query.trim() && scrollEl) scrollEl.scrollTop = 0; }, { defer: true }));

  return (
    <>
      <div class="col-sub">
        <input
          ref={(el) => { searchEl = el; onCleanup(() => { if (searchEl === el) searchEl = undefined; }); }}
          class="search tree-search"
          placeholder="filter scope/name"
          value={s.treeQuery}
          spellcheck={false}
          onInput={(ev) => s.setTreeQuery(ev.currentTarget.value)}
          onKeyDown={(ev) => {
            // Enter adds the selection, or the first matched signal in tree order
            // when there is none; Esc clears the query, then hands Escape back to
            // the panel.
            if (ev.key === "Enter") {
              ev.preventDefault();
              if (s.treeSelection.length) { addSelection(); return; }
              const first = flat().find((row) => row.matched && row.kind === "signal");
              const ids = first ? resolveAddIds([first.id]) : [];
              if (ids.length) { perf.beginAdd(); s.addSignals(ids); }
            } else if (ev.key === "Escape" && s.treeQuery) {
              ev.preventDefault();
              s.setTreeQuery("");
            }
          }}
        />
        <Show when={searching()}>
          <span class="hint">{found.loading ? "…" : matchLabel()}</span>
          <span class="collapse" data-tip="clear filter" onClick={() => { s.setTreeQuery(""); searchEl?.focus(); }}><X size={12} /></span>
        </Show>
      </div>
      <div
        class="tree"
        ref={scrollEl}
        tabindex={0}
        onKeyDown={(ev) => {
          if (ev.key === "Enter") { ev.preventDefault(); addSelection(); }
          else if (ev.key === "Escape") { ev.preventDefault(); s.clearTreeSelection(); }
        }}
      >
        <div style={{ position: "relative", width: "100%", height: `${virtualizer.getTotalSize()}px` }}>
        <Key each={windowNodes()} by={(w) => w.node.id}>{(item) => {
          const e = () => item().node;
          const node = createMemo(() => { s.traceNonce; return SCENE.hierarchy.nodes.get(e().id); });
          // Immediate (non-recursive) signal children of a scope — the set the
          // scope's plus button adds. Empty for signal rows / signal-less scopes.
          const sigChildren = createMemo<NodeId[]>(() => { s.traceNonce; return immediateSigChildren(e().id); });
          // A signal row is addable only if tide ingested data for it (Signal.
          // supported). Unsupported rows render dimmed + non-addable with a tip.
          const supported = createMemo(() => {
            const n = node();
            return !(n && n.kind === "signal" && !n.supported);
          });
          const isSel = createMemo(() => selected().has(e().id));
          // Merge a contiguous selected run into one rounded block: round only the
          // run's outer corners (top row → top corners, bottom row → bottom corners),
          // squaring the shared edges. A lone selected row keeps all four (4px base).
          const radius = createMemo<string | undefined>(() => {
            if (!isSel()) return undefined;
            const f = flat(); const i = item().idx;
            const up = i > 0 && !!f[i - 1] && selected().has(f[i - 1].id);
            const dn = i < f.length - 1 && !!f[i + 1] && selected().has(f[i + 1].id);
            const top = up ? "0" : "4px", bot = dn ? "0" : "4px";
            return `${top} ${top} ${bot} ${bot}`;
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
              class={"t-row" + (supported() ? "" : " unsupported") + (isSel() ? " sel" : "")}
              // Filtered rows spell out where they sit only in the tooltip — the
              // tree itself now shows it. Unsupported rows keep saying why they
              // cannot be added.
              data-tip={!supported() ? "unsupported type (real/string or no samples) — can't be displayed" : searching() ? pathOf(SCENE.hierarchy, e().id) : undefined}
              style={{
                position: "absolute", top: 0, left: 0, width: "100%",
                transform: `translateY(${item().start}px)`,
                opacity: op(),
                transition: ROW_TRANSITION,
                "border-radius": radius(),
                "padding-left": e().depth > 0 ? `${4 + e().depth * 14}px` : undefined,
              }}
              // Suppress the browser's shift-click text-selection extension (keeps
              // the click; shift-range-select shouldn't highlight row text).
              onMouseDown={(ev) => { if (ev.shiftKey) ev.preventDefault(); }}
              onClick={(ev) => select(e().id, ev)}
              // Double-click: signal → add it; scope → expand. Filtered, a scope is
              // already open and there is nothing to toggle, so it leaves the filter
              // and opens itself in the full tree instead.
              onDblClick={(ev) => {
                ev.preventDefault();
                if (e().kind === "signal") { if (supported()) { perf.beginAdd(); s.addSignal(e().id); } }
                else if (searching()) reveal(e().id);
                else { pulseExpand(); s.toggleScope(e().id); }
              }}
              onContextMenu={(ev) => {
                ev.preventDefault();
                // Right-click outside the selection retargets it to this node (so the
                // menu's "Add" acts on what was clicked); inside it, keep the selection.
                if (!selected().has(e().id)) s.selectTreeNode(e().id, {}, flat().map((f) => f.id));
                s.setCtxMenu({ x: ev.clientX, y: ev.clientY, row: -1, kind: "tree", nodeId: e().id });
              }}
            >
              <span
                class="chev"
                style={e().kind === "scope" && !searching() ? {
                  transform: e().open ? "rotate(90deg)" : "rotate(0deg)",
                  transition: "transform 0.18s ease",
                } : undefined}
                // Chevron toggles expand without selecting (stop propagation to the
                // row). Filtered, every kept scope is open by construction and
                // collapsing one would hide a match, so it shows no chevron.
                onClick={(ev) => { if (e().kind === "scope" && !searching()) { ev.stopPropagation(); pulseExpand(); s.toggleScope(e().id); } }}
              >
                {e().kind === "scope" && !searching() ? <ChevronRight size={10} /> : null}
              </span>
              <span class={iconClass()}>{e().kind === "scope" ? <Package size={12} /> : <Activity size={12} />}</span>
              <span class="lbl"><Highlight text={node()?.name ?? ""} ranges={windowRanges().get(e().id)} /></span>
              {e().kind === "signal" ? (
                supported() ? (
                  <span
                    class="plus"
                    data-tip={isSel() && s.treeSelection.length > 1 ? `add ${resolveAddIds(s.treeSelection).length} signals` : "add to viewer"}
                    onClick={(ev) => {
                      ev.stopPropagation();
                      // In the selection → add the whole selection; otherwise just this row.
                      if (isSel()) addSelection();
                      else { perf.beginAdd(); s.addSignal(e().id); }
                    }}
                  ><Plus size={12} /></span>
                ) : null
              ) : sigChildren().length > 0 || (isSel() && s.treeSelection.length > 1) ? (
                <span
                  class="plus"
                  data-tip={isSel() && s.treeSelection.length > 1 ? `add ${resolveAddIds(s.treeSelection).length} signals` : "add all signals in scope"}
                  onClick={(ev) => {
                    ev.stopPropagation();
                    if (isSel()) addSelection();
                    else { perf.beginAdd(); s.addSignals(sigChildren()); }
                  }}
                ><Plus size={12} /></span>
              ) : null}
            </div>
          );
        }}</Key>
        </div>
      </div>
    </>
  );
}
