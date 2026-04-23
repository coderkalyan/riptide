import { useState } from "react";
import { Activity, ChevronDown, ChevronRight, Package, Plus } from "lucide-react";
import type { Hierarchy, NodeId, Signal } from "./hier/types";
import { getScope } from "./hier/hierarchy";

export function signalIconKind(sig: Signal): "enum" | "bus" | "scalar" {
  if (sig.enumTypeId != null) return "enum";
  if (sig.bitWidth > 1) return "bus";
  return "scalar";
}

export function SignalTreeView({
  hierarchy,
  initialExpanded,
}: {
  hierarchy: Hierarchy;
  initialExpanded: Set<NodeId>;
}) {
  const [expanded, setExpanded] = useState<Set<NodeId>>(initialExpanded);
  const toggle = (id: NodeId) => {
    const next = new Set(expanded);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setExpanded(next);
  };

  return (
    <div className="tree">
      {hierarchy.rootIds.map((id) => (
        <TreeNode key={id} id={id} depth={0} hierarchy={hierarchy} expanded={expanded} toggle={toggle} />
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
        {isOpen && node.children.map((childId) => (
          <TreeNode
            key={childId}
            id={childId}
            depth={depth + 1}
            hierarchy={hierarchy}
            expanded={expanded}
            toggle={toggle}
          />
        ))}
      </>
    );
  }

  const kind = signalIconKind(node);
  return (
    <div className={`t-row ${indent}`.trim()}>
      <span className="chev" />
      <span className={`icon ${kind}`}><Activity size={12} /></span>
      <span className="lbl">{node.name}</span>
      <span className="plus"><Plus size={12} /></span>
    </div>
  );
}

// Re-export so App.tsx can traverse from hierarchy when needed.
export { getScope };
