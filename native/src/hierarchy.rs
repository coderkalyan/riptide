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
    },
    Signal {
        parent: Option<NodeId>,
        name: String,
        /// The renderer's `VarType`, which VCD's container axis collapses onto.
        var_type: &'static str,
        bit_width: Width,
        /// The database key, or zero when no signal backs this variable. Ids are
        /// one-based, so zero is free as the absent marker.
        handle: u64,
        /// Whether the database holds samples under `handle`. False for a
        /// variable whose type it cannot store, and for one declared but never
        /// assigned. The renderer refuses to add an unsupported signal to a row.
        supported: bool,
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

/// The whole tree, plus the ids of everything at the top level.
pub struct Flat {
    pub nodes: Vec<Node>,
    pub root_ids: Vec<NodeId>,
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
pub fn flatten(hierarchy: &Hierarchy, db: &Database) -> Flat {
    let mut flat = Flat {
        nodes: Vec::with_capacity(hierarchy.scopes().len() + hierarchy.vars().len()),
        root_ids: Vec::new(),
    };

    // Explicit stack rather than recursion: nesting depth is whatever the file
    // declares. Children are pushed reversed so they pop in declaration order,
    // and a scope's own node is created when it pops, ahead of its contents.
    let mut stack = vec![(ScopeId::ROOT, None)];
    while let Some((scope, parent)) = stack.pop() {
        let owner = if scope == ScopeId::ROOT {
            None
        } else {
            let kind = scope_kind(hierarchy.scope(scope).kind);
            let name = hierarchy.string(hierarchy.scope(scope).name).to_owned();
            Some(flat.attach(
                parent,
                Node::Scope {
                    parent,
                    name,
                    kind,
                    children: Vec::new(),
                },
            ))
        };

        for var in hierarchy.scope_vars(scope) {
            let node = Node::Signal {
                parent: owner,
                name: hierarchy.string(var.name).to_owned(),
                var_type: var_kind(var.kind),
                bit_width: var.ty.width(),
                // Ids are one-based, so zero is free as "no signal behind it".
                handle: var.signal.map_or(0, |id| id.0),
                supported: var.signal.is_some_and(|id| db.contains(id)),
            };
            flat.attach(owner, node);
        }

        for &child in hierarchy.children(scope).iter().rev() {
            stack.push((child, owner));
        }
    }

    flat
}

impl Flat {
    /// Appends `node` and links it under `parent`, or records it as a root.
    fn attach(&mut self, parent: Option<NodeId>, node: Node) -> NodeId {
        let id = self.nodes.len() as NodeId;
        match parent {
            Some(parent) => match &mut self.nodes[parent as usize] {
                Node::Scope { children, .. } => children.push(id),
                Node::Signal { .. } => unreachable!("a signal cannot parent a node"),
            },
            None => self.root_ids.push(id),
        }
        self.nodes.push(node);
        id
    }
}
