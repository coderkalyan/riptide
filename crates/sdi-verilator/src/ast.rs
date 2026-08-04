//! A borrowed, arena-backed reader for `verilator --json-only` output.
//!
//! Verilator's dump is a uniform envelope — `type`, `name`, `addr`, `loc`, some
//! scalars, some pointer fields holding `addr` strings, and named child slots that
//! are always arrays — over 48 node types. So one generic node covers all of them
//! and there is nothing to keep in step with Verilator's node list.
//!
//! Three decisions keep this cheap on a large dump:
//!
//! * **Borrowed strings.** Fields are `Cow<str>` over the input buffer, so the
//!   common case copies nothing. (Cow rather than `&str` because Verilator escapes
//!   control characters, and an escaped string cannot be borrowed.)
//! * **One arena.** Nodes live in a single `Vec`; children are index ranges into a
//!   flat `Vec<NodeId>`. No `Vec` per AST slot, which on a million-node dump would
//!   be millions of small allocations.
//! * **Built during deserialization.** A `DeserializeSeed` writes straight into the
//!   arena, so the tree is never materialized twice.

use std::borrow::Cow;
use std::collections::HashMap;
use std::ops::Range;

use serde::de::{DeserializeSeed, IgnoredAny, MapAccess, SeqAccess, Visitor};
use serde::Deserializer;

pub type NodeId = u32;
pub type Str<'a> = Cow<'a, str>;

/// Boolean flags Verilator emits only when true.
#[derive(Clone, Copy, Default, PartialEq, Eq, Debug)]
pub struct Flags(u16);

impl Flags {
    const SIGNED: u16 = 1 << 0;
    const PACKED: u16 = 1 << 1;
    const FOUR_STATE: u16 = 1 << 2;
    const IMPLIED: u16 = 1 << 3;
    const PARAM: u16 = 1 << 4;
    const GPARAM: u16 = 1 << 5;
    const PRIMARY_CLOCK: u16 = 1 << 6;
    const CONST: u16 = 1 << 7;
    const TAGGED: u16 = 1 << 8;
    const SOFT: u16 = 1 << 9;
    const ASCENDING: u16 = 1 << 10;
    const PRIMARY_IO: u16 = 1 << 11;
    const SIG_PUBLIC: u16 = 1 << 12;

    fn set(&mut self, bit: u16, on: bool) {
        if on {
            self.0 |= bit;
        }
    }
    fn has(self, bit: u16) -> bool {
        self.0 & bit != 0
    }

    pub fn signed(self) -> bool {
        self.has(Self::SIGNED)
    }
    pub fn packed(self) -> bool {
        self.has(Self::PACKED)
    }
    pub fn four_state(self) -> bool {
        self.has(Self::FOUR_STATE)
    }
    pub fn implied(self) -> bool {
        self.has(Self::IMPLIED)
    }
    pub fn is_param(self) -> bool {
        self.has(Self::PARAM) || self.has(Self::GPARAM)
    }
    pub fn primary_clock(self) -> bool {
        self.has(Self::PRIMARY_CLOCK)
    }
    pub fn tagged(self) -> bool {
        self.has(Self::TAGGED)
    }
    /// Reserved: SystemVerilog soft unions are not modelled yet.
    #[allow(dead_code)]
    pub fn soft(self) -> bool {
        self.has(Self::SOFT)
    }
    /// Reserved: the declared range already carries direction.
    #[allow(dead_code)]
    pub fn ascending(self) -> bool {
        self.has(Self::ASCENDING)
    }
}

/// One AST node. Only the fields this converter reads are kept; everything else in
/// the dump is skipped without allocating.
#[derive(Default, Debug)]
pub struct Node<'a> {
    pub ty: Str<'a>,
    pub name: Str<'a>,
    pub addr: Str<'a>,
    pub loc: Str<'a>,
    pub orig_name: Option<Str<'a>>,
    pub keyword: Option<Str<'a>>,
    pub direction: Option<Str<'a>>,
    pub var_type: Option<Str<'a>>,
    pub dtype_name: Option<Str<'a>>,
    pub range: Option<Str<'a>>,
    pub decl_range: Option<Str<'a>>,
    pub edge_type: Option<Str<'a>>,
    pub access: Option<Str<'a>>,
    pub modport_name: Option<Str<'a>>,
    pub iface_name: Option<Str<'a>>,
    pub width_const: Option<u32>,
    pub level: Option<u32>,
    pub flags: Flags,
    /// Pointer fields, as `addr` strings. `UNLINKED` is normalized to `None`.
    pub dtypep: Option<Str<'a>>,
    pub ref_dtypep: Option<Str<'a>>,
    pub varp: Option<Str<'a>>,
    pub modp: Option<Str<'a>>,
    pub mod_varp: Option<Str<'a>>,
    pub typedefp: Option<Str<'a>>,
    slots: Range<u32>,
}

/// A named child list.
#[derive(Debug)]
struct Slot<'a> {
    name: Str<'a>,
    children: Range<u32>,
}

#[derive(Default)]
pub struct Ast<'a> {
    nodes: Vec<Node<'a>>,
    slots: Vec<Slot<'a>>,
    child_ids: Vec<NodeId>,
    by_addr: HashMap<Str<'a>, NodeId>,
    /// Depth-first scratch for child ids: each recursion level claims a suffix and
    /// truncates it, so one buffer serves the whole walk.
    scratch: Vec<NodeId>,
    /// The same discipline for slots. A node's slots cannot be written straight to
    /// `slots`, because its children finish first and would land in the middle of
    /// the parent's range.
    slot_scratch: Vec<Slot<'a>>,
    root: NodeId,
}

impl<'a> Ast<'a> {
    /// Parse a whole `Vtop.tree.json`.
    pub fn parse(bytes: &'a [u8]) -> Result<Self, serde_json::Error> {
        let mut ast = Ast::default();
        let mut de = serde_json::Deserializer::from_slice(bytes);
        // A dump's depth is genuine expression nesting — `assign q = a ^ b ^ …` over
        // 1500 terms is 1500 levels — not hostile input, so the default 128-deep
        // guard is wrong here. The stack this needs is provided by the caller.
        de.disable_recursion_limit();
        let root = NodeSeed { ast: &mut ast }.deserialize(&mut de)?;
        de.end()?;
        ast.root = root;
        Ok(ast)
    }

    pub fn root(&self) -> &Node<'a> {
        &self.nodes[self.root as usize]
    }
    pub fn node(&self, id: NodeId) -> &Node<'a> {
        &self.nodes[id as usize]
    }
    pub fn len(&self) -> usize {
        self.nodes.len()
    }

    /// Resolve a pointer field.
    pub fn at(&self, addr: Option<&Str<'a>>) -> Option<NodeId> {
        self.by_addr.get(addr?.as_ref()).copied()
    }

    /// Children of a named slot, empty when the slot is absent.
    pub fn kids(&self, id: NodeId, slot: &str) -> &[NodeId] {
        let node = &self.nodes[id as usize];
        for s in &self.slots[node.slots.start as usize..node.slots.end as usize] {
            if s.name == slot {
                return &self.child_ids[s.children.start as usize..s.children.end as usize];
            }
        }
        &[]
    }

    /// First child of a named slot.
    pub fn kid(&self, id: NodeId, slot: &str) -> Option<NodeId> {
        self.kids(id, slot).first().copied()
    }

    /// Every slot name of a node, in emission order.
    pub fn slot_names(&self, id: NodeId) -> impl Iterator<Item = &str> {
        let node = &self.nodes[id as usize];
        self.slots[node.slots.start as usize..node.slots.end as usize]
            .iter()
            .map(|s| s.name.as_ref())
    }

    /// Depth-first walk of a subtree, including the root of it.
    pub fn descend(&self, id: NodeId, mut f: impl FnMut(NodeId)) {
        let mut stack = vec![id];
        while let Some(n) = stack.pop() {
            f(n);
            let node = &self.nodes[n as usize];
            for s in &self.slots[node.slots.start as usize..node.slots.end as usize] {
                stack.extend(
                    self.child_ids[s.children.start as usize..s.children.end as usize]
                        .iter()
                        .copied(),
                );
            }
        }
    }
}

// ------------------------------------------------------------------ the seed

struct NodeSeed<'b, 'a> {
    ast: &'b mut Ast<'a>,
}

impl<'de: 'a, 'a, 'b> DeserializeSeed<'de> for NodeSeed<'b, 'a> {
    type Value = NodeId;

    fn deserialize<D: Deserializer<'de>>(self, d: D) -> Result<NodeId, D::Error> {
        d.deserialize_map(self)
    }
}

impl<'de: 'a, 'a, 'b> Visitor<'de> for NodeSeed<'b, 'a> {
    type Value = NodeId;

    fn expecting(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
        f.write_str("a verilator AST node object")
    }

    fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<NodeId, A::Error> {
        let id = self.ast.nodes.len() as NodeId;
        self.ast.nodes.push(Node::default());

        // Both scratches work the same way: claim a suffix, let deeper levels claim
        // and release theirs above it, then move our own tail into the arena.
        let slot_mark = self.ast.slot_scratch.len();

        while let Some(key) = map.next_key::<Str<'a>>()? {
            match key.as_ref() {
                "type" => self.ast.nodes[id as usize].ty = map.next_value()?,
                "name" => self.ast.nodes[id as usize].name = map.next_value()?,
                "addr" => {
                    let addr: Str<'a> = map.next_value()?;
                    self.ast.by_addr.insert(addr.clone(), id);
                    self.ast.nodes[id as usize].addr = addr;
                }
                "loc" => self.ast.nodes[id as usize].loc = map.next_value()?,
                "origName" => self.ast.nodes[id as usize].orig_name = Some(map.next_value()?),
                "keyword" => self.ast.nodes[id as usize].keyword = Some(map.next_value()?),
                "direction" => self.ast.nodes[id as usize].direction = Some(map.next_value()?),
                "varType" => self.ast.nodes[id as usize].var_type = Some(map.next_value()?),
                "dtypeName" => self.ast.nodes[id as usize].dtype_name = Some(map.next_value()?),
                "range" => self.ast.nodes[id as usize].range = Some(map.next_value()?),
                "declRange" => self.ast.nodes[id as usize].decl_range = Some(map.next_value()?),
                "edgeType" => self.ast.nodes[id as usize].edge_type = Some(map.next_value()?),
                "access" => self.ast.nodes[id as usize].access = Some(map.next_value()?),
                "modportName" => self.ast.nodes[id as usize].modport_name = Some(map.next_value()?),
                "ifaceName" => self.ast.nodes[id as usize].iface_name = Some(map.next_value()?),
                "widthConst" => self.ast.nodes[id as usize].width_const = Some(map.next_value()?),
                "level" => self.ast.nodes[id as usize].level = Some(map.next_value()?),

                "dtypep" => self.ast.nodes[id as usize].dtypep = linked(map.next_value()?),
                "refDTypep" => self.ast.nodes[id as usize].ref_dtypep = linked(map.next_value()?),
                "varp" => self.ast.nodes[id as usize].varp = linked(map.next_value()?),
                "modp" => self.ast.nodes[id as usize].modp = linked(map.next_value()?),
                "modVarp" => self.ast.nodes[id as usize].mod_varp = linked(map.next_value()?),
                "typedefp" => self.ast.nodes[id as usize].typedefp = linked(map.next_value()?),

                // Verilator omits every boolean that is false, so presence is truth.
                "signed" => flag(&mut self.ast.nodes[id as usize], Flags::SIGNED, &mut map)?,
                "packed" => flag(&mut self.ast.nodes[id as usize], Flags::PACKED, &mut map)?,
                "isFourstate" => flag(&mut self.ast.nodes[id as usize], Flags::FOUR_STATE, &mut map)?,
                "implied" => flag(&mut self.ast.nodes[id as usize], Flags::IMPLIED, &mut map)?,
                "isParam" => flag(&mut self.ast.nodes[id as usize], Flags::PARAM, &mut map)?,
                "isGParam" => flag(&mut self.ast.nodes[id as usize], Flags::GPARAM, &mut map)?,
                "isPrimaryClock" => {
                    flag(&mut self.ast.nodes[id as usize], Flags::PRIMARY_CLOCK, &mut map)?
                }
                "isPrimaryIO" => flag(&mut self.ast.nodes[id as usize], Flags::PRIMARY_IO, &mut map)?,
                "isSigPublic" => flag(&mut self.ast.nodes[id as usize], Flags::SIG_PUBLIC, &mut map)?,
                "isConst" => flag(&mut self.ast.nodes[id as usize], Flags::CONST, &mut map)?,
                "isTagged" => flag(&mut self.ast.nodes[id as usize], Flags::TAGGED, &mut map)?,
                "isSoft" => flag(&mut self.ast.nodes[id as usize], Flags::SOFT, &mut map)?,
                "ascending" => flag(&mut self.ast.nodes[id as usize], Flags::ASCENDING, &mut map)?,

                // Anything else is either a child list or a field we do not read.
                // One seed handles both: arrays become children, scalars are dropped.
                _ => {
                    let mark = self.ast.scratch.len();
                    let is_seq = map.next_value_seed(SlotSeed { ast: self.ast })?;
                    if is_seq && self.ast.scratch.len() > mark {
                        let start = self.ast.child_ids.len() as u32;
                        self.ast.child_ids.extend_from_slice(&self.ast.scratch[mark..]);
                        let end = self.ast.child_ids.len() as u32;
                        self.ast.slot_scratch.push(Slot { name: key, children: start..end });
                    }
                    self.ast.scratch.truncate(mark);
                }
            }
        }

        // Children finished before us, so their slots sit above ours in the scratch
        // — already drained by their own levels. What remains from our mark is ours.
        let Ast { slots, slot_scratch, nodes, .. } = &mut *self.ast;
        let start = slots.len() as u32;
        slots.extend(slot_scratch.drain(slot_mark..));
        let end = slots.len() as u32;
        nodes[id as usize].slots = start..end;
        self.ast.scratch.push(id);
        Ok(id)
    }
}

fn linked<'a>(value: Str<'a>) -> Option<Str<'a>> {
    if value == "UNLINKED" || value.is_empty() {
        None
    } else {
        Some(value)
    }
}

fn flag<'de, A: MapAccess<'de>>(node: &mut Node<'_>, bit: u16, map: &mut A) -> Result<(), A::Error> {
    let on: bool = map.next_value()?;
    node.flags.set(bit, on);
    Ok(())
}

/// Deserializes a value that is *either* a child array or something we ignore.
/// Returns whether it was an array. serde has no way to peek, so this dispatches
/// through `deserialize_any` and accepts every scalar shape as "not a slot".
struct SlotSeed<'b, 'a> {
    ast: &'b mut Ast<'a>,
}

impl<'de: 'a, 'a, 'b> DeserializeSeed<'de> for SlotSeed<'b, 'a> {
    type Value = bool;

    fn deserialize<D: Deserializer<'de>>(self, d: D) -> Result<bool, D::Error> {
        d.deserialize_any(self)
    }
}

impl<'de: 'a, 'a, 'b> Visitor<'de> for SlotSeed<'b, 'a> {
    type Value = bool;

    fn expecting(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
        f.write_str("a child array or any scalar")
    }

    fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<bool, A::Error> {
        // Each child pushes its own id onto the scratch as it completes.
        while seq.next_element_seed(NodeSeed { ast: self.ast })?.is_some() {}
        Ok(true)
    }

    fn visit_str<E>(self, _: &str) -> Result<bool, E> {
        Ok(false)
    }
    fn visit_borrowed_str<E>(self, _: &'de str) -> Result<bool, E> {
        Ok(false)
    }
    fn visit_string<E>(self, _: String) -> Result<bool, E> {
        Ok(false)
    }
    fn visit_i64<E>(self, _: i64) -> Result<bool, E> {
        Ok(false)
    }
    fn visit_u64<E>(self, _: u64) -> Result<bool, E> {
        Ok(false)
    }
    fn visit_f64<E>(self, _: f64) -> Result<bool, E> {
        Ok(false)
    }
    fn visit_bool<E>(self, _: bool) -> Result<bool, E> {
        Ok(false)
    }
    fn visit_none<E>(self) -> Result<bool, E> {
        Ok(false)
    }
    fn visit_unit<E>(self) -> Result<bool, E> {
        Ok(false)
    }
    fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<bool, A::Error> {
        while map.next_entry::<IgnoredAny, IgnoredAny>()?.is_some() {}
        Ok(false)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = r#"
    {"type":"NETLIST","name":"$root","addr":"(B)","loc":"a,0:0,0:0",
     "modulesp": [
       {"type":"MODULE","name":"top","addr":"(E)","loc":"e,9:8,9:11","level":1,
        "stmtsp": [
          {"type":"VAR","name":"clk","addr":"(H)","loc":"e,11:17,11:19","dtypep":"(I)",
           "direction":"INPUT","varType":"PORT","isPrimaryIO":true,
           "childDTypep": [],"valuep": []},
          {"type":"CELL","name":"u_sub","addr":"(Q)","loc":"e,28:16,28:21","modp":"UNLINKED",
           "pinsp": [
             {"type":"PIN","name":"clk","addr":"(S)","modVarp":"(T)",
              "exprp": [
                {"type":"VARREF","name":"clk","addr":"(U)","access":"RD","varp":"(H)"}
              ]}
           ]}
        ]}
     ],
     "filesp": [], "miscsp": []}"#;

    #[test]
    fn builds_an_arena_and_indexes_every_addr() {
        let ast = Ast::parse(SAMPLE.as_bytes()).unwrap();
        assert_eq!(ast.len(), 6); // NETLIST, MODULE, VAR, CELL, PIN, VARREF
        assert_eq!(ast.root().ty, "NETLIST");
        let module = ast.kid(0, "modulesp").unwrap();
        assert_eq!(ast.node(module).name, "top");
        assert_eq!(ast.node(module).level, Some(1));
    }

    #[test]
    fn keeps_slots_scoped_to_their_own_node() {
        let ast = Ast::parse(SAMPLE.as_bytes()).unwrap();
        let module = ast.kid(0, "modulesp").unwrap();
        let stmts = ast.kids(module, "stmtsp");
        assert_eq!(stmts.len(), 2);
        assert_eq!(ast.node(stmts[0]).ty, "VAR");
        assert_eq!(ast.node(stmts[1]).ty, "CELL");
        // The VAR's own empty slots must not have swallowed the CELL.
        assert!(ast.kids(stmts[0], "childDTypep").is_empty());
        let pins = ast.kids(stmts[1], "pinsp");
        assert_eq!(pins.len(), 1);
        let expr = ast.kid(pins[0], "exprp").unwrap();
        assert_eq!(ast.node(expr).ty, "VARREF");
    }

    #[test]
    fn resolves_pointers_and_drops_unlinked() {
        let ast = Ast::parse(SAMPLE.as_bytes()).unwrap();
        let module = ast.kid(0, "modulesp").unwrap();
        let cell = ast.kids(module, "stmtsp")[1];
        assert!(ast.node(cell).modp.is_none(), "UNLINKED must normalize to None");
        let varref = ast.kid(ast.kids(cell, "pinsp")[0], "exprp").unwrap();
        let varp = ast.at(ast.node(varref).varp.as_ref()).unwrap();
        assert_eq!(ast.node(varp).name, "clk");
        assert_eq!(ast.node(varp).direction.as_deref(), Some("INPUT"));
    }

    #[test]
    fn records_only_flags_that_are_present() {
        let ast = Ast::parse(SAMPLE.as_bytes()).unwrap();
        let module = ast.kid(0, "modulesp").unwrap();
        let var = ast.kids(module, "stmtsp")[0];
        assert!(ast.node(var).flags.has(Flags::PRIMARY_IO));
        assert!(!ast.node(var).flags.signed());
    }

    #[test]
    fn descends_a_whole_subtree() {
        let ast = Ast::parse(SAMPLE.as_bytes()).unwrap();
        let mut seen = 0;
        ast.descend(0, |_| seen += 1);
        assert_eq!(seen, ast.len());
    }
}
