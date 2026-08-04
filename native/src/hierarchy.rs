//! The scope tree as the renderer consumes it.
//!
//! tide's hierarchy is two slices — scopes and variables, each grouped by owning
//! scope. The renderer wants one flat array of nodes addressed by a dense id,
//! with scopes carrying their children, so this flattens the former into the
//! latter once at load. Node ids are array indices, assigned depth first with a
//! scope's variables ahead of its subscopes, which is the order the signal tree
//! renders in.

use tide_core::Database;
use tide_core::hierarchy::{Hierarchy, ScopeId, ScopeKind, VarKind};
use tide_core::metadata::Width;

use crate::design::{Design, ScopeFacts, VarFacts};
use crate::search::Index;

/// A node's index into [`Flat::nodes`].
pub type NodeId = u32;

pub enum Node {
    Scope {
        parent: Option<NodeId>,
        name: String,
        /// tide's format-agnostic kind, spelled the way the renderer's
        /// `ScopeType` enum does.
        kind: &'static str,
        /// Variables then subscopes, in declaration order.
        children: Vec<NodeId>,
        /// What source debug info adds about this scope.
        facts: Option<ScopeFacts>,
    },
    Signal {
        parent: Option<NodeId>,
        name: String,
        /// The renderer's `VarType`. VCD's container axis collapses onto two of
        /// them; SDI, when there is any, supplies the declared one instead.
        var_type: &'static str,
        bit_width: Width,
        /// The database key, or zero when no signal backs this variable. Ids are
        /// one-based, so zero is free as the absent marker.
        handle: u64,
        /// Whether the database holds samples under `handle`. False for a
        /// variable whose type it cannot store, and for one declared but never
        /// assigned. The renderer refuses to add an unsupported signal to a row.
        supported: bool,
        /// What source debug info adds, when an SDI file sits beside the trace.
        /// `None` everywhere when it does not, which is the VCD-grade tree.
        facts: Option<VarFacts>,
    },
}

impl Node {
    pub fn parent(&self) -> Option<NodeId> {
        match self {
            Node::Scope { parent, .. } | Node::Signal { parent, .. } => *parent,
        }
    }

    pub fn name(&self) -> &str {
        match self {
            Node::Scope { name, .. } | Node::Signal { name, .. } => name,
        }
    }
}

/// The whole tree, the ids of everything at the top level, and the search index
/// over the same nodes.
pub struct Flat {
    pub nodes: Vec<Node>,
    pub root_ids: Vec<NodeId>,
    /// Enum int->label tables from the SDI, empty without one. Referenced by a
    /// signal's `facts.enum_type`.
    pub enums: Vec<crate::design::EnumTable>,
    /// Fuzzy-searchable paths, entry `i` being `nodes[i]`. Immutable once built,
    /// so a background search shares it without synchronizing.
    pub search: Index,
}

/// One row of a pruned tree view.
pub struct Row {
    pub id: NodeId,
    /// Nesting depth *within the pruned tree*, which equals the depth in the full
    /// tree: pruning drops whole subtrees, never an intermediate scope.
    pub depth: u32,
    /// Whether this node is one of the kept ones rather than a scope above one.
    pub matched: bool,
}

impl Flat {
    /// The `keep` nodes plus every scope above them, depth first in tree order.
    ///
    /// This is the tree with everything that did not match pruned away and
    /// everything leading to a match opened — the shape the signal tree renders
    /// while a filter is live. It runs here, off the JS thread, because it is
    /// linear in the hierarchy and a filter recomputes it on every keystroke.
    pub fn prune(&self, keep: &[NodeId]) -> Vec<Row> {
        const MATCHED: u8 = 1;
        const ON_PATH: u8 = 2;

        let mut state = vec![0u8; self.nodes.len()];
        for &id in keep {
            let Some(flags) = state.get_mut(id as usize) else {
                continue;
            };
            *flags |= MATCHED | ON_PATH;
            // Open the scopes above it, stopping at the first already-open one:
            // every ancestor of that one is open too, which keeps the whole pass
            // linear in the tree rather than quadratic in its depth.
            let mut cursor = self.nodes[id as usize].parent();
            while let Some(at) = cursor {
                if state[at as usize] & ON_PATH != 0 {
                    break;
                }
                state[at as usize] |= ON_PATH;
                cursor = self.nodes[at as usize].parent();
            }
        }

        let mut rows = Vec::with_capacity(keep.len());
        // Explicit stack, like `flatten`: nesting depth is whatever the file says.
        let mut stack: Vec<(NodeId, u32)> = self
            .root_ids
            .iter()
            .rev()
            .map(|&id| (id, 0))
            .collect();
        while let Some((id, depth)) = stack.pop() {
            if state[id as usize] & ON_PATH == 0 {
                continue;
            }
            rows.push(Row {
                id,
                depth,
                matched: state[id as usize] & MATCHED != 0,
            });
            if let Node::Scope { children, .. } = &self.nodes[id as usize] {
                for &child in children.iter().rev() {
                    stack.push((child, depth + 1));
                }
            }
        }
        rows
    }
}

/// tide's scope kinds in the vocabulary the renderer's `ScopeType` uses. VCD
/// distinguishes task from function and begin from fork, but tide's format
/// agnostic axis does not, so both pairs land on one spelling each.
fn scope_kind(kind: ScopeKind) -> &'static str {
    match kind {
        ScopeKind::Instance => "module",
        ScopeKind::Block => "begin",
        ScopeKind::Procedure => "task",
        ScopeKind::Container => "package",
        _ => "module",
    }
}

/// tide's container axis as the renderer's two-valued `VarType`. Anything
/// assigned procedurally reads as a register; everything else is a net.
fn var_kind(kind: VarKind) -> &'static str {
    match kind {
        VarKind::Variable => "vcd_reg",
        _ => "vcd_wire",
    }
}

/// Flattens `hierarchy` depth first. The synthetic root scope is not itself a
/// node: its subscopes and any variable declared outside a scope become roots.
pub fn flatten(hierarchy: &Hierarchy, db: &Database, design: Option<&Design>) -> Flat {
    let mut walk = Walk {
        nodes: Vec::with_capacity(hierarchy.scopes().len() + hierarchy.vars().len()),
        root_ids: Vec::new(),
        search: Index::new(),
    };

    // Explicit stack rather than recursion: nesting depth is whatever the file
    // declares. Children are pushed reversed so they pop in declaration order,
    // and a scope's own node is created when it pops, ahead of its contents.
    let mut stack = vec![(ScopeId::ROOT, None)];
    while let Some((scope, parent)) = stack.pop() {
        let owner = if scope == ScopeId::ROOT {
            None
        } else {
            let scope = hierarchy.scope(scope);
            let path = hierarchy.string(scope.path);
            let facts = design.and_then(|d| d.scope(path)).cloned();
            // A declared scope kind beats tide's four-way axis, which cannot tell a
            // package from a module.
            let kind = facts
                .as_ref()
                .and_then(|f| f.scope_type)
                .unwrap_or_else(|| scope_kind(scope.kind));
            let name = hierarchy.string(scope.name).to_owned();
            Some(walk.attach(
                parent,
                Node::Scope {
                    parent,
                    name,
                    kind,
                    children: Vec::new(),
                    facts,
                },
                path,
            ))
        };

        for var in hierarchy.scope_vars(scope) {
            let path = hierarchy.string(var.path);
            let facts = design.and_then(|d| d.var(path)).cloned();
            let node = Node::Signal {
                parent: owner,
                name: hierarchy.string(var.name).to_owned(),
                // The declared type when SDI knows it, else the container axis,
                // which is all the trace itself carries.
                var_type: facts
                    .as_ref()
                    .and_then(|f| f.var_type)
                    .unwrap_or_else(|| var_kind(var.kind)),
                bit_width: var.ty.width(),
                // Ids are one-based, so zero is free as "no signal behind it".
                handle: var.signal.map_or(0, |id| id.0),
                supported: var.signal.is_some_and(|id| db.contains(id)),
                facts,
            };
            walk.attach(owner, node, path);
        }

        for &child in hierarchy.children(scope).iter().rev() {
            stack.push((child, owner));
        }
    }

    Flat {
        nodes: walk.nodes,
        root_ids: walk.root_ids,
        enums: design.map(|d| d.enums.clone()).unwrap_or_default(),
        search: walk.search,
    }
}

/// The tree under construction. Separate from [`Flat`] so the index it fills is
/// still owned outright, and so `attach` is the only way to add a node — which is
/// what keeps the index aligned with the node array.
struct Walk {
    nodes: Vec<Node>,
    root_ids: Vec<NodeId>,
    search: Index,
}

impl Walk {
    /// Appends `node` and links it under `parent`, or records it as a root.
    /// `path` is the node's dot path, indexed under the id it returns.
    fn attach(&mut self, parent: Option<NodeId>, node: Node, path: &str) -> NodeId {
        let id = self.nodes.len() as NodeId;
        match parent {
            Some(parent) => match &mut self.nodes[parent as usize] {
                Node::Scope { children, .. } => children.push(id),
                Node::Signal { .. } => unreachable!("a signal cannot parent a node"),
            },
            None => self.root_ids.push(id),
        }
        self.nodes.push(node);
        self.search.push(path);
        id
    }
}

#[cfg(test)]
mod tests {
    use std::path::Path;

    use crate::design::Design;
    use crate::hierarchy::Node;

    /// The bundled mock ships an SDI, so flattening it must carry the declared
    /// types, directions, declaration sites and enum tables through to the nodes
    /// the renderer reads — and a trace without one must carry none of it.
    #[test]
    fn enriches_from_source_debug_info() {
        let trace = Path::new(env!("CARGO_MANIFEST_DIR")).join("src/mock.vcd");
        let source = std::fs::read(&trace).unwrap();
        let (parsed, _) = tide_vcd::load::load(&source).unwrap();

        let design = Design::beside(&trace).expect("the mock ships an SDI");
        let rich = super::flatten(&parsed.hierarchy, &parsed.db, Some(&design));
        let bare = super::flatten(&parsed.hierarchy, &parsed.db, None);

        assert!(!rich.enums.is_empty(), "enum tables should reach the tree");
        assert!(bare.enums.is_empty(), "without an SDI there are none");

        let find = |flat: &super::Flat, name: &str| -> usize {
            flat.nodes
                .iter()
                .position(|n| n.name() == name)
                .unwrap_or_else(|| panic!("no node named {name}"))
        };

        // A port whose declared type the VCD flattens to `wire`.
        match &rich.nodes[find(&rich, "rst_n")] {
            Node::Signal { var_type, facts, .. } => {
                assert_eq!(*var_type, "sv_logic");
                let facts = facts.as_ref().expect("facts");
                assert_eq!(facts.direction, Some("input"));
                assert_eq!(facts.comment.as_deref(), Some("active-low reset"));
                assert!(facts.decl.is_some());
            }
            other => panic!("rst_n is not a signal: {:?}", other.name()),
        }
        // The same node, with no SDI: back to the container axis.
        match &bare.nodes[find(&bare, "rst_n")] {
            Node::Signal { var_type, facts, .. } => {
                assert_eq!(*var_type, "vcd_wire");
                assert!(facts.is_none());
            }
            other => panic!("rst_n is not a signal: {:?}", other.name()),
        }
        // A scope kind tide cannot express.
        match &rich.nodes[find(&rich, "derived")] {
            Node::Scope { kind, .. } => assert_eq!(*kind, "package"),
            other => panic!("derived is not a scope: {:?}", other.name()),
        }
        match &bare.nodes[find(&bare, "derived")] {
            Node::Scope { kind, .. } => assert_eq!(*kind, "module"),
            other => panic!("derived is not a scope: {:?}", other.name()),
        }
    }
}
