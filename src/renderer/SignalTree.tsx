import { useState } from "react";
import { Activity, ChevronDown, ChevronRight, Package, Plus } from "lucide-react";
import type { Hierarchy, NodeId, Signal } from "./hier/types";
import { getScope } from "./hier/hierarchy";

export function signalIconKind(sig: Signal): "enum" | "bus" | "scalar" {
  if (sig.enumTypeId != null) return "enum";
  if (sig.bitWidth > 1) return "bus";
  return "scalar";
}

// Hoisted icon elements — one instance each, shared across every row. Each lucide
// icon is an <svg> subtree; recreating them per node (thousands of rows on a big
// trace) is wasted allocation + reconcile. Sharing the element lets React skip
// re-rendering them on a row re-render (same element reference bails).
const CHEVRON_DOWN = <ChevronDown size={10} />;
const CHEVRON_RIGHT = <ChevronRight size={10} />;
const ICON_MODULE = <Package size={12} />;
const ICON_SIGNAL = <Activity size={12} />;
const ICON_PLUS = <Plus size={12} />;

// Tree expansion is owned by App (so it can be persisted to the sidecar) and
// passed down as `expanded` + `onToggle`. The full hierarchy can be thousands of
// nodes; the React Compiler (build-time auto-memoization) caches this element +
// its callback props in App's render, so an unrelated state change (e.g. adding
// an active signal) no longer reconciles the whole tree.
export function SignalTreeView({
  hierarchy,
  expanded,
  onToggle,
  onAdd,
}: {
  hierarchy: Hierarchy;
  expanded: Set<NodeId>;
  onToggle: (id: NodeId) => void;
  // Add a signal node to the active list (the per-row "+" button).
  onAdd: (id: NodeId) => void;
}) {
  return (
    <div className="tree">
      {hierarchy.rootIds.map((id) => (
        <TreeNode key={id} id={id} depth={0} hierarchy={hierarchy} expanded={expanded} toggle={onToggle} add={onAdd} />
      ))}
    </div>
  );
}

function TreeNode({
  id,
  depth,
  hierarchy,
  expanded,
  toggle,
  add,
}: {
  id: NodeId;
  depth: number;
  hierarchy: Hierarchy;
  expanded: Set<NodeId>;
  toggle: (id: NodeId) => void;
  add: (id: NodeId) => void;
}) {
  const node = hierarchy.nodes.get(id)!;
  const indent = depth > 0 ? `indent-${depth}` : "";

  // Lazy mount: a scope's children are rendered only once the scope has been
  // opened at least once (`everOpened`). A collapsed-and-never-opened subtree
  // stays out of the DOM entirely — so opening a trace mounts just the initially
  // expanded nodes, not the whole hierarchy. Once opened, children stay mounted
  // (everOpened latches true) so the 0fr↔1fr collapse animation still runs both
  // ways and re-expanding is instant. Render-phase setState is a supported React
  // pattern for deriving state from props (re-renders before commit, no paint).
  const isOpen = node.kind === "scope" && expanded.has(id);
  const [everOpened, setEverOpened] = useState(isOpen);
  if (isOpen && !everOpened) setEverOpened(true);

  if (node.kind === "scope") {
    return (
      <>
        <div className={`t-row ${indent}`.trim()} onClick={() => toggle(id)}>
          <span className="chev">{isOpen ? CHEVRON_DOWN : CHEVRON_RIGHT}</span>
          <span className="icon module">{ICON_MODULE}</span>
          <span className="lbl">{node.name}</span>
        </div>
        <div className={`t-children${isOpen ? " open" : ""}`}>
          <div className="t-children-inner">
            {everOpened && node.children.map((childId) => (
              <TreeNode
                key={childId}
                id={childId}
                depth={depth + 1}
                hierarchy={hierarchy}
                expanded={expanded}
                toggle={toggle}
                add={add}
              />
            ))}
          </div>
        </div>
      </>
    );
  }

  const kind = signalIconKind(node);
  return (
    <div className={`t-row ${indent}`.trim()}>
      <span className="chev" />
      <span className={`icon ${kind}`}>{ICON_SIGNAL}</span>
      <span className="lbl">{node.name}</span>
      <span
        className="plus"
        data-tip="add to viewer"
        onClick={(e) => { e.stopPropagation(); add(id); }}
      >{ICON_PLUS}</span>
    </div>
  );
}

// Re-export so App.tsx can traverse from hierarchy when needed.
export { getScope };
