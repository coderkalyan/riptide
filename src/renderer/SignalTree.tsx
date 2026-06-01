import { Activity, ChevronDown, ChevronRight, Package, Plus } from "lucide-react";
import type { Hierarchy, NodeId, Signal } from "./hier/types";
import { getScope } from "./hier/hierarchy";

export function signalIconKind(sig: Signal): "enum" | "bus" | "scalar" {
  if (sig.enumTypeId != null) return "enum";
  if (sig.bitWidth > 1) return "bus";
  return "scalar";
}

// Tree expansion is owned by App (so it can be persisted to the sidecar) and
// passed down as `expanded` + `onToggle`.
export function SignalTreeView({
  hierarchy,
  expanded,
  onToggle,
}: {
  hierarchy: Hierarchy;
  expanded: Set<NodeId>;
  onToggle: (id: NodeId) => void;
}) {
  return (
    <div className="tree">
      {hierarchy.rootIds.map((id) => (
        <TreeNode key={id} id={id} depth={0} hierarchy={hierarchy} expanded={expanded} toggle={onToggle} />
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
}: {
  id: NodeId;
  depth: number;
  hierarchy: Hierarchy;
  expanded: Set<NodeId>;
  toggle: (id: NodeId) => void;
}) {
  const node = hierarchy.nodes.get(id)!;
  const indent = depth > 0 ? `indent-${depth}` : "";

  if (node.kind === "scope") {
    const isOpen = expanded.has(id);
    return (
      <>
        <div className={`t-row ${indent}`.trim()} onClick={() => toggle(id)}>
          <span className="chev">{isOpen ? <ChevronDown size={10} /> : <ChevronRight size={10} />}</span>
          <span className="icon module"><Package size={12} /></span>
          <span className="lbl">{node.name}</span>
        </div>
        {/* Children stay mounted so the height transition runs on collapse too;
            the grid 0fr↔1fr animates to/from auto height. */}
        <div className={`t-children${isOpen ? " open" : ""}`}>
          <div className="t-children-inner">
            {node.children.map((childId) => (
              <TreeNode
                key={childId}
                id={childId}
                depth={depth + 1}
                hierarchy={hierarchy}
                expanded={expanded}
                toggle={toggle}
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
      <span className={`icon ${kind}`}><Activity size={12} /></span>
      <span className="lbl">{node.name}</span>
      <span className="plus" data-tip="add to viewer"><Plus size={12} /></span>
    </div>
  );
}

// Re-export so App.tsx can traverse from hierarchy when needed.
export { getScope };
