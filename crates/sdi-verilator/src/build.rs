//! The conversion itself: Verilator's AST into SDI units, refs and processes.
//!
//! Three mappings do the work, and all three are things the dump leaves implicit:
//!
//! * **Scopes.** A `MODULE` becomes a unit, and so does each `GENBLOCK` — except the
//!   `implied` wrapper a generate loop creates, whose children are hoisted because no
//!   dumper emits a scope for it.
//! * **References.** A `VARREF.varp` names a `VAR` that may live in an enclosing
//!   scope, so the converter counts lexical hops and emits `up`. That is the common
//!   case in real RTL, not an edge case.
//! * **Control dependence.** Verilator nests assignments under `IF`/`CASE`; walking
//!   that nesting is what turns an enclosing condition into a `role: "control"`
//!   source and marks the write `guarded`.

use std::collections::HashMap;

use sdi::{
    Assign, Bits, Conn, Direction, Edge, HintRole, Hints, Instance, InstanceKind, Param,
    ParamOverride, Process, ProcessKind, Ref, RefRole, Sdi, Sense, SenseRole, Span, TypeKind,
    Unit, UnitKind, Var, VarKind,
};

use crate::ast::{Ast, NodeId};
use crate::source::Sources;
use crate::types::{Types, const_value};

/// What the caller knows and Verilator cannot: how the dumper treated unpacked
/// arrays. IEEE `$dumpvars` skips them entirely; other tools emit one signal per
/// element. Only a human knows which trace this SDI is being written against.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum UnpackedArrays {
    /// Say nothing, and let the binding check report them as unexplained.
    Keep,
    /// Mark them `traceOmitted`.
    Omit,
    /// Map each element to its own trace signal.
    Elements,
}

pub struct Options {
    pub unpacked_arrays: UnpackedArrays,
    pub lean: bool,
}

pub struct Builder<'a, 'ast> {
    ast: &'a Ast<'ast>,
    pub out: Sdi,
    pub src: Sources,
    types: Types,
    pub notes: Vec<String>,
    opts: Options,
    /// Verilator MODULE/GENBLOCK addr -> unit index.
    unit_of: HashMap<String, u32>,
    /// Verilator VAR addr -> (unit, index in that unit's vars).
    var_site: HashMap<String, (u32, u32)>,
    /// Lexical parent of a unit, for counting `up` hops.
    parent: HashMap<u32, u32>,
}

impl<'a, 'ast> Builder<'a, 'ast> {
    pub fn new(ast: &'a Ast<'ast>, src: Sources, out: Sdi, opts: Options) -> Self {
        Self {
            ast,
            out,
            src,
            types: Types::new(),
            notes: Vec::new(),
            opts,
            unit_of: HashMap::new(),
            var_site: HashMap::new(),
            parent: HashMap::new(),
        }
    }

    fn note(&mut self, message: impl Into<String>) {
        let message = message.into();
        if !self.notes.contains(&message) {
            self.notes.push(message);
        }
    }

    fn span(&mut self, id: NodeId) -> Option<Span> {
        let loc = self.ast.node(id).loc.clone();
        self.src.span(&loc)
    }

    fn intern_type(&mut self, addr_of: NodeId) -> Option<u32> {
        let dtypep = self.ast.node(addr_of).dtypep.clone();
        self.types
            .intern(self.ast, &mut self.out, &mut self.src, &mut self.notes, dtypep.as_ref())
    }

    /// Statement and item children — the two slots a scope's contents live in.
    fn contents(&self, id: NodeId) -> Vec<NodeId> {
        let mut out = self.ast.kids(id, "stmtsp").to_vec();
        out.extend_from_slice(self.ast.kids(id, "itemsp"));
        out
    }

    /// Generate blocks that own a trace scope, hoisting Verilator's `implied` wrapper.
    fn scope_blocks(&mut self, id: NodeId) -> Vec<NodeId> {
        let mut out = Vec::new();
        for child in self.contents(id) {
            let node = self.ast.node(child);
            if node.ty != "GENBLOCK" && node.ty != "BEGIN" {
                continue;
            }
            if node.flags.implied() || node.name.is_empty() {
                self.note("hoisted an implied generate wrapper, which no dumper emits as a scope");
                out.extend(self.scope_blocks(child));
            } else {
                out.push(child);
            }
        }
        out
    }

    /// Widest span across a subtree. Verilator's `loc` is the identifier only, so an
    /// end line has to be derived; a viewer cannot, without parsing the language.
    fn body_span(&mut self, id: NodeId) -> Option<Span> {
        let mut ids = Vec::new();
        self.ast.descend(id, |n| ids.push(n));
        let mut file = None;
        let mut lo = u32::MAX;
        let mut hi = 0;
        for n in ids {
            let Some(s) = self.span(n) else { continue };
            let f = *file.get_or_insert(s.file);
            if s.file != f {
                continue;
            }
            lo = lo.min(s.line);
            hi = hi.max(if s.end_line != 0 { s.end_line } else { s.line });
        }
        let file = file?;
        if lo == u32::MAX {
            return None;
        }
        Some(if hi > lo {
            Span { file, line: lo, col: 1, end_line: hi, end_col: 0 }
        } else {
            Span::line(file, lo)
        })
    }

    // ------------------------------------------------------------------ units

    /// Pass one: create every unit and place its variables, so references can
    /// resolve in pass two regardless of declaration order.
    pub fn declare_units(&mut self) {
        let modules: Vec<NodeId> = self
            .ast
            .kids(0, "modulesp")
            .iter()
            .copied()
            .filter(|m| self.ast.node(*m).name != "@CONST-POOL@")
            .collect();
        for m in modules {
            let kind = match self.ast.node(m).ty.as_ref() {
                "PACKAGE" => UnitKind::Package,
                "IFACE" => UnitKind::Interface,
                "PRIMITIVE" => UnitKind::Udp,
                _ => UnitKind::Module,
            };
            self.declare_unit(m, kind, None);
        }
    }

    fn declare_unit(&mut self, id: NodeId, kind: UnitKind, parent: Option<u32>) -> u32 {
        let node = self.ast.node(id);
        let name = node.name.as_ref().to_string();
        let orig = node.orig_name.as_deref().map(str::to_string);
        let addr = node.addr.as_ref().to_string();

        let idx = self.out.units.len() as u32;
        let mut unit = Unit::new(kind, name.as_str());
        unit.orig_name = match orig {
            Some(o) if o != name => Some(o.into()),
            _ if kind == UnitKind::GenBlock && name.contains('[') => {
                Some(name.split('[').next().unwrap_or(&name).into())
            }
            _ => None,
        };
        unit.decl = self.span(id);
        unit.body = self.body_span(id);
        unit.comment = unit.decl.and_then(|d| self.src.doc_comment(d));
        self.out.units.push(unit);
        self.unit_of.insert(addr, idx);
        if let Some(p) = parent {
            self.parent.insert(idx, p);
        }

        for child in self.contents(id) {
            if self.ast.node(child).ty != "VAR" {
                continue;
            }
            self.declare_var(idx, child);
        }

        for block in self.scope_blocks(id) {
            self.declare_unit(block, UnitKind::GenBlock, Some(idx));
        }
        idx
    }

    fn declare_var(&mut self, unit: u32, id: NodeId) {
        let node = self.ast.node(id);
        let var_type = node.var_type.as_deref().unwrap_or("VAR").to_string();
        let direction = node.direction.as_deref().unwrap_or("NONE").to_string();
        let addr = node.addr.as_ref().to_string();
        let name = node
            .orig_name
            .as_deref()
            .unwrap_or(node.name.as_ref())
            .to_string();
        let is_param = node.flags.is_param() || var_type == "GPARAM" || var_type == "LPARAM";
        let value = self
            .ast
            .kid(id, "valuep")
            .and_then(|v| const_value(self.ast, v));
        let decl = self.span(id);
        let ty = self.intern_type(id);

        if is_param {
            let comment = decl.and_then(|d| self.src.doc_comment(d));
            self.out.units[unit as usize].params.push(Param {
                name: name.into(),
                ty,
                value,
                local: var_type == "LPARAM",
                decl,
                comment,
            });
            return;
        }

        let Some(ty) = ty else {
            self.note(format!("variable {name} has no resolvable type and was skipped"));
            return;
        };

        let mut var = Var::new(name.as_str(), ty);
        let kind = match self.out.ty(ty).map(|t| t.kind) {
            Some(TypeKind::UnpackedArray) => VarKind::Memory,
            _ => var_kind(&var_type),
        };
        var.kind = Some(kind);
        var.net_type = net_type(&var_type).map(Into::into);
        let dir = direction_of(&direction);
        if dir.is_some_and(Direction::is_port) {
            var.direction = dir;
        }
        var.decl = decl;
        var.comment = decl.and_then(|d| self.src.doc_comment(d));
        var.value = value;
        if self.ast.node(id).flags.primary_clock() {
            var.hints = Some(Hints { role: Some(HintRole::Clock), ..Default::default() });
        }
        self.apply_unpacked_policy(&mut var, ty);

        let unit_ref = &mut self.out.units[unit as usize];
        let vi = unit_ref.vars.len() as u32;
        if var.direction.is_some() {
            unit_ref.ports.push(vi);
        }
        unit_ref.vars.push(var);
        self.var_site.insert(addr, (unit, vi));
    }

    /// Record what the caller told us about the dumper's unpacked-array behaviour.
    fn apply_unpacked_policy(&mut self, var: &mut Var, ty: u32) {
        if self.opts.unpacked_arrays == UnpackedArrays::Keep {
            return;
        }
        let Some(t) = self.out.ty(ty) else { return };
        if t.kind != TypeKind::UnpackedArray {
            return;
        }
        if self.opts.unpacked_arrays == UnpackedArrays::Omit {
            var.trace_omitted = true;
            return;
        }
        let (Some(range), Some(elem)) = (t.range, t.elem) else { return };
        let Some(ew) = self.out.width_of(elem) else { return };
        let [left, right] = range;
        let low = left.min(right);
        let step: i64 = if left <= right { 1 } else { -1 };
        let mut k = left;
        loop {
            let offset = ((k - low) as u32) * ew;
            var.trace_signals.push(sdi::TraceSignal {
                path: format!("{}[{k}]", var.name).into(),
                bits: Some(Bits::new(offset, ew)),
                member: Some(format!("[{k}]").into()),
            });
            if k == right {
                break;
            }
            k += step;
        }
    }

    // ------------------------------------------------- instances and processes

    /// Pass two: fill in instances, connections and processes, now that every
    /// variable has a home a reference can name.
    pub fn fill(&mut self) {
        let modules: Vec<(NodeId, u32)> = self
            .ast
            .kids(0, "modulesp")
            .iter()
            .copied()
            .filter_map(|m| {
                let addr = self.ast.node(m).addr.as_ref();
                self.unit_of.get(addr).copied().map(|u| (m, u))
            })
            .collect();
        for (node, unit) in modules {
            self.fill_scope(node, unit);
        }
    }

    fn fill_scope(&mut self, id: NodeId, unit: u32) {
        for child in self.contents(id) {
            match self.ast.node(child).ty.as_ref() {
                "CELL" => self.fill_cell(child, unit),
                "ALWAYS" | "INITIAL" | "FINAL" => {
                    if let Some(p) = self.build_process(child, unit) {
                        self.out.units[unit as usize].processes.push(p);
                    }
                }
                _ => {}
            }
        }
        for block in self.scope_blocks(id) {
            let addr = self.ast.node(block).addr.as_ref().to_string();
            let Some(&child_unit) = self.unit_of.get(&addr) else { continue };
            let name = self.ast.node(block).name.as_ref().to_string();
            let mut inst = Instance::new(name, InstanceKind::GenBlock);
            inst.unit = Some(child_unit);
            inst.decl = self.span(block);
            self.out.units[unit as usize].instances.push(inst);
            self.fill_scope(block, child_unit);
        }
    }

    fn fill_cell(&mut self, id: NodeId, unit: u32) {
        let node = self.ast.node(id);
        let name = node.name.as_ref().to_string();
        let modp = node.modp.clone();
        let child_unit = modp
            .as_ref()
            .and_then(|m| self.ast.at(Some(m)))
            .map(|m| self.ast.node(m).addr.as_ref().to_string())
            .and_then(|addr| self.unit_of.get(&addr).copied());

        let mut inst = Instance::new(name.as_str(), InstanceKind::Instance);
        inst.unit = child_unit;
        if child_unit.is_none() {
            inst.black_box = true;
            self.note(format!("cell {name} has no module body; emitted as a black box"));
        }
        inst.decl = self.span(id);

        for pin in self.ast.kids(id, "pinsp").to_vec() {
            let pin_node = self.ast.node(pin);
            let pin_name = pin_node.name.as_ref().to_string();
            let mod_varp = pin_node.mod_varp.as_ref().map(|s| s.to_string());
            let mut conn = Conn { name: Some(pin_name.clone().into()), ..Default::default() };
            if let (Some(child), Some(formal)) = (child_unit, mod_varp) {
                if let Some(&(_, vi)) = self.var_site.get(&formal)
                    && let Some(ord) = self.out.unit(child).and_then(|u| u.port_ordinal(vi))
                {
                    conn.port = Some(ord);
                }
            }
            conn.loc = self.span(pin);
            if let Some(expr) = self.ast.kid(pin, "exprp") {
                conn.reads = self.refs_in(expr, unit, None, Access::Read);
                conn.writes = self.refs_in(expr, unit, None, Access::Write);
            }
            if !self.opts.lean {
                conn.text = conn.loc.and_then(|l| self.src.line_text(l));
            }
            if !conn.reads.is_empty() || !conn.writes.is_empty() {
                inst.conns.push(conn);
            }
        }

        for param in self.ast.kids(id, "paramsp").to_vec() {
            let pn = self.ast.node(param);
            if pn.ty != "PIN" {
                continue;
            }
            let name = pn.name.as_ref().to_string();
            let value = self
                .ast
                .kid(param, "exprp")
                .and_then(|e| const_value(self.ast, e));
            let loc = self.span(param);
            inst.params.push(ParamOverride {
                name: name.into(),
                value,
                loc,
                text: if self.opts.lean { None } else { loc.and_then(|l| self.src.line_text(l)) },
            });
        }

        self.out.units[unit as usize].instances.push(inst);
    }

    fn build_process(&mut self, id: NodeId, unit: u32) -> Option<Process> {
        let node = self.ast.node(id);
        let kind = match node.keyword.as_deref() {
            Some("cont_assign") => ProcessKind::ContAssign,
            Some("always_ff") => ProcessKind::AlwaysFf,
            Some("always_comb") => ProcessKind::AlwaysComb,
            Some("always_latch") => ProcessKind::AlwaysLatch,
            Some("always") => ProcessKind::Always,
            _ => match node.ty.as_ref() {
                "INITIAL" => ProcessKind::Initial,
                "FINAL" => ProcessKind::Final,
                _ => ProcessKind::Always,
            },
        };
        let mut proc = Process::new(kind);
        proc.loc = self.span(id);

        for tree in self.ast.kids(id, "sentreep").to_vec() {
            for item in self.ast.kids(tree, "sensesp").to_vec() {
                let edge = match self.ast.node(item).edge_type.as_deref() {
                    Some("POS") => Edge::Pos,
                    Some("NEG") => Edge::Neg,
                    _ => Edge::Any,
                };
                let Some(sensp) = self.ast.kid(item, "sensp") else { continue };
                let mut found = None;
                self.ast.descend(sensp, |n| {
                    if found.is_none() && self.ast.node(n).ty == "VARREF" {
                        found = Some(n);
                    }
                });
                let Some(varref) = found else { continue };
                let name = self.ast.node(varref).name.as_ref().to_string();
                let Some(reference) = self.make_ref(varref, &[], unit, None) else { continue };
                let role = sense_role(&name).or(if edge.is_edge() {
                    Some(SenseRole::Clock)
                } else {
                    None
                });
                proc.sense.push(Sense {
                    edge: (edge != Edge::Any).then_some(edge),
                    reference,
                    role,
                });
            }
        }

        let mut assigns = Vec::new();
        let mut reads = Vec::new();
        self.walk_statements(id, unit, &[], &mut assigns, &mut reads);
        proc.assigns = assigns;
        proc.reads = reads;

        (!proc.assigns.is_empty() || !proc.reads.is_empty()).then_some(proc)
    }

    /// Walk a process body, carrying the enclosing conditions down so each write
    /// records its control dependence.
    fn walk_statements(
        &mut self,
        id: NodeId,
        unit: u32,
        controls: &[Ref],
        assigns: &mut Vec<Assign>,
        reads: &mut Vec<Ref>,
    ) {
        match self.ast.node(id).ty.as_ref() {
            "ASSIGN" | "ASSIGNW" | "ASSIGNDLY" => {
                let non_blocking = self.ast.node(id).ty == "ASSIGNDLY";
                let Some(lhs) = self.ast.kid(id, "lhsp") else { return };
                let targets = self.refs_in(lhs, unit, None, Access::Write);
                if targets.is_empty() {
                    return;
                }
                let mut sources = match self.ast.kid(id, "rhsp") {
                    Some(rhs) => self.refs_in(rhs, unit, None, Access::Read),
                    None => Vec::new(),
                };
                sources.extend(controls.iter().cloned());
                let loc = self.span(id);
                assigns.push(Assign {
                    loc,
                    targets,
                    sources,
                    non_blocking,
                    delay: None,
                    guarded: !controls.is_empty(),
                    text: if self.opts.lean {
                        None
                    } else {
                        loc.and_then(|l| self.src.line_text(l))
                    },
                });
            }
            "IF" => {
                let mut nested = controls.to_vec();
                if let Some(cond) = self.ast.kid(id, "condp") {
                    nested.extend(self.refs_in(cond, unit, Some(RefRole::Control), Access::Read));
                }
                for slot in ["thensp", "elsesp"] {
                    for child in self.ast.kids(id, slot).to_vec() {
                        self.walk_statements(child, unit, &nested, assigns, reads);
                    }
                }
            }
            "CASE" => {
                let mut nested = controls.to_vec();
                if let Some(expr) = self.ast.kid(id, "exprp") {
                    nested.extend(self.refs_in(expr, unit, Some(RefRole::Control), Access::Read));
                }
                for item in self.ast.kids(id, "itemsp").to_vec() {
                    for child in self.ast.kids(item, "stmtsp").to_vec() {
                        self.walk_statements(child, unit, &nested, assigns, reads);
                    }
                }
            }
            "DISPLAY" | "STOP" | "FINISH" | "ASSERT" | "COVER" => {
                reads.extend(self.refs_in(id, unit, None, Access::Read));
            }
            _ => {
                let slots: Vec<String> = self.ast.slot_names(id).map(str::to_string).collect();
                for slot in slots {
                    for child in self.ast.kids(id, &slot).to_vec() {
                        self.walk_statements(child, unit, controls, assigns, reads);
                    }
                }
            }
        }
    }

    // ------------------------------------------------------------- references

    /// Collect every `VARREF` in an expression, with the bit slice its enclosing
    /// `SEL`/`ARRAYSEL` chain implies.
    fn refs_in(&mut self, id: NodeId, unit: u32, role: Option<RefRole>, want: Access) -> Vec<Ref> {
        let mut out = Vec::new();
        self.collect_refs(id, unit, role, want, &mut Vec::new(), &mut out);
        out
    }

    fn collect_refs(
        &mut self,
        id: NodeId,
        unit: u32,
        role: Option<RefRole>,
        want: Access,
        chain: &mut Vec<NodeId>,
        out: &mut Vec<Ref>,
    ) {
        let ty = self.ast.node(id).ty.clone();
        if ty == "VARREF" {
            let access = self.ast.node(id).access.as_deref().unwrap_or("RD").to_string();
            if want.matches(&access)
                && let Some(r) = self.make_ref(id, chain, unit, role)
            {
                out.push(r);
            }
            return;
        }

        let is_select = ty == "SEL" || ty == "ARRAYSEL";
        let slots: Vec<String> = self.ast.slot_names(id).map(str::to_string).collect();
        for slot in slots {
            // A select's index is itself a read, and a non-constant one is why a
            // reference gets `role: "index"` rather than silently disappearing.
            let is_index = (ty == "SEL" && slot == "lsbp") || (ty == "ARRAYSEL" && slot == "bitp");
            for child in self.ast.kids(id, &slot).to_vec() {
                if is_index {
                    let mut empty = Vec::new();
                    self.collect_refs(child, unit, Some(RefRole::Index), Access::Read, &mut empty, out);
                    continue;
                }
                if is_select && slot == "fromp" {
                    chain.push(id);
                    self.collect_refs(child, unit, role, want, chain, out);
                    chain.pop();
                } else {
                    self.collect_refs(child, unit, role, want, chain, out);
                }
            }
        }
    }

    fn make_ref(
        &mut self,
        varref: NodeId,
        chain: &[NodeId],
        home: u32,
        role: Option<RefRole>,
    ) -> Option<Ref> {
        let node = self.ast.node(varref);
        let name = node.name.as_ref().to_string();
        let varp = node.varp.as_ref().map(|s| s.to_string());

        let Some((owner, vi)) = varp.as_ref().and_then(|a| self.var_site.get(a)).copied() else {
            self.note(format!("unresolved reference to {name}, emitted as an xmr"));
            return Some(Ref::xmr(name).with_role(role));
        };

        let Some(up) = self.up_hops(home, owner) else {
            self.note(format!(
                "reference to {name} crosses a module boundary, emitted as an xmr"
            ));
            return Some(Ref::xmr(name).with_role(role));
        };

        let ty = self.out.unit(owner).and_then(|u| u.vars.get(vi as usize)).map(|v| v.ty);
        let (bits, dynamic) = self.slice_of(chain, ty);
        let mut r = Ref::var(vi).with_up(up).with_bits(bits).with_role(role);
        r.dynamic = dynamic;
        if !self.opts.lean && !chain.is_empty() {
            r.select = Some(self.select_text(&name, chain).into());
        }
        Some(r)
    }

    /// Lexical hops from `home` out to `owner`, or `None` when a module boundary
    /// blocks the path — which is what `conns` exists to cross.
    fn up_hops(&self, home: u32, owner: u32) -> Option<u32> {
        let mut cur = home;
        for hops in 0..64 {
            if cur == owner {
                return Some(hops);
            }
            if !self.out.unit(cur)?.kind.is_block() {
                return None;
            }
            cur = *self.parent.get(&cur)?;
        }
        None
    }

    /// Resolve a `SEL`/`ARRAYSEL` chain into a flattened bit slice. A non-constant
    /// index yields `dynamic`, so a consumer widens conservatively instead of
    /// trusting a precise-looking lie.
    fn slice_of(&self, chain: &[NodeId], ty: Option<u32>) -> (Option<Bits>, bool) {
        let mut bits: Option<Bits> = None;
        let mut dynamic = false;
        for &node in chain.iter().rev() {
            let n = self.ast.node(node);
            match n.ty.as_ref() {
                "SEL" => {
                    let lsb = self
                        .ast
                        .kid(node, "lsbp")
                        .and_then(|l| const_value(self.ast, l))
                        .and_then(scalar_of);
                    match (lsb, n.width_const) {
                        (Some(lsb), Some(w)) => {
                            let base = bits.map(|b| b.lsb).unwrap_or(0);
                            bits = Some(Bits::new(base + lsb as u32, w));
                        }
                        _ => dynamic = true,
                    }
                }
                "ARRAYSEL" => {
                    let idx = self
                        .ast
                        .kid(node, "bitp")
                        .and_then(|b| const_value(self.ast, b))
                        .and_then(scalar_of);
                    let elem = ty.and_then(|t| self.out.ty(t)).and_then(|t| t.elem);
                    let ew = elem.and_then(|e| self.out.width_of(e));
                    let low = ty
                        .and_then(|t| self.out.ty(t))
                        .and_then(|t| t.range)
                        .map(|[l, r]| l.min(r))
                        .unwrap_or(0);
                    match (idx, ew) {
                        (Some(i), Some(ew)) => {
                            let base = bits.map(|b| b.lsb).unwrap_or(0);
                            bits = Some(Bits::new(base + ((i - low) as u32) * ew, ew));
                        }
                        _ => dynamic = true,
                    }
                }
                _ => {}
            }
        }
        (bits, dynamic)
    }

    fn select_text(&self, name: &str, chain: &[NodeId]) -> String {
        let mut out = name.to_string();
        for &node in chain.iter().rev() {
            let n = self.ast.node(node);
            match n.ty.as_ref() {
                "ARRAYSEL" => {
                    let idx = self
                        .ast
                        .kid(node, "bitp")
                        .and_then(|b| const_value(self.ast, b))
                        .and_then(scalar_of);
                    match idx {
                        Some(i) => out.push_str(&format!("[{i}]")),
                        None => out.push_str("[?]"),
                    }
                }
                "SEL" => {
                    let lsb = self
                        .ast
                        .kid(node, "lsbp")
                        .and_then(|l| const_value(self.ast, l))
                        .and_then(scalar_of);
                    match (lsb, n.width_const) {
                        (Some(lsb), Some(w)) => {
                            out.push_str(&format!("[{}:{}]", lsb + w as i64 - 1, lsb));
                        }
                        _ => out.push_str("[?]"),
                    }
                }
                _ => {}
            }
        }
        out
    }

    /// The design root: Verilator marks the top with `level: 1`.
    pub fn top_unit(&self) -> Option<(u32, String)> {
        let mut fallback = None;
        for &m in self.ast.kids(0, "modulesp") {
            let node = self.ast.node(m);
            if node.name == "@CONST-POOL@" {
                continue;
            }
            let unit = self.unit_of.get(node.addr.as_ref()).copied()?;
            let name = node.name.as_ref().to_string();
            if node.level == Some(1) {
                return Some((unit, name));
            }
            fallback.get_or_insert((unit, name));
        }
        fallback
    }

    pub fn has_black_box(&self) -> bool {
        self.out
            .units
            .iter()
            .any(|u| u.instances.iter().any(|i| i.black_box))
    }
}

/// Which side of an assignment a reference is on. Verilator marks every `VARREF`
/// with `RD`, `WR` or `RW`, so lvalues need no structural guessing.
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Access {
    Read,
    Write,
}

impl Access {
    fn matches(self, access: &str) -> bool {
        match self {
            Access::Read => access == "RD" || access == "RW",
            Access::Write => access == "WR" || access == "RW",
        }
    }
}

fn scalar_of(value: sdi::Value) -> Option<i64> {
    match value {
        sdi::Value::Str(s) => {
            if let Some(hex) = s.strip_prefix("0x") {
                i64::from_str_radix(hex, 16).ok()
            } else if let Some(bin) = s.strip_prefix("0b") {
                i64::from_str_radix(bin, 2).ok()
            } else {
                s.parse().ok()
            }
        }
        sdi::Value::Num(n) => Some(n as i64),
        sdi::Value::Bool(b) => Some(b as i64),
    }
}

fn var_kind(var_type: &str) -> VarKind {
    match var_type {
        "GPARAM" | "LPARAM" | "SPECPARAM" => VarKind::Param,
        "GENVAR" => VarKind::Genvar,
        "SUPPLY0" | "SUPPLY1" | "WIRE" | "WREAL" | "TRIAND" | "TRIOR" | "TRIWIRE" | "TRI0"
        | "TRI1" => VarKind::Net,
        _ => VarKind::Var,
    }
}

fn net_type(var_type: &str) -> Option<&'static str> {
    Some(match var_type {
        "SUPPLY0" => "supply0",
        "SUPPLY1" => "supply1",
        "WIRE" => "wire",
        "TRIAND" => "triand",
        "TRIOR" => "trior",
        "TRIWIRE" => "tri",
        "TRI0" => "tri0",
        "TRI1" => "tri1",
        _ => return None,
    })
}

fn direction_of(direction: &str) -> Option<Direction> {
    Some(match direction {
        "INPUT" => Direction::Input,
        "OUTPUT" => Direction::Output,
        "INOUT" => Direction::Inout,
        "REF" | "CONSTREF" => Direction::Ref,
        _ => return None,
    })
}

/// Verilator does not label a clock or reset, but a sensitivity list plus a naming
/// convention identifies one well enough to seed a viewer's row roles.
fn sense_role(name: &str) -> Option<SenseRole> {
    let lower = name.to_ascii_lowercase();
    let is = |needles: &[&str]| {
        needles.iter().any(|n| {
            lower == *n
                || lower.starts_with(&format!("{n}_"))
                || lower.ends_with(&format!("_{n}"))
                || lower.contains(&format!("_{n}_"))
        })
    };
    if is(&["clk", "clock"]) {
        Some(SenseRole::Clock)
    } else if is(&["rst", "reset", "rstn", "resetn", "nreset"]) {
        Some(SenseRole::Reset)
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recognises_clock_and_reset_names() {
        assert_eq!(sense_role("clk"), Some(SenseRole::Clock));
        assert_eq!(sense_role("core_clk"), Some(SenseRole::Clock));
        assert_eq!(sense_role("clk_sys"), Some(SenseRole::Clock));
        assert_eq!(sense_role("rst_n"), Some(SenseRole::Reset));
        assert_eq!(sense_role("i_reset"), Some(SenseRole::Reset));
        assert_eq!(sense_role("data"), None);
        assert_eq!(sense_role("clocking_wizard"), None, "must not match a substring");
    }

    #[test]
    fn maps_verilator_var_types() {
        assert_eq!(var_kind("WIRE"), VarKind::Net);
        assert_eq!(var_kind("VAR"), VarKind::Var);
        assert_eq!(var_kind("GENVAR"), VarKind::Genvar);
        assert_eq!(var_kind("GPARAM"), VarKind::Param);
        assert_eq!(net_type("TRI0"), Some("tri0"));
        assert_eq!(net_type("VAR"), None);
        assert_eq!(direction_of("INPUT"), Some(Direction::Input));
        assert_eq!(direction_of("NONE"), None);
    }

    #[test]
    fn access_selects_the_right_side_of_an_assignment() {
        assert!(Access::Read.matches("RD"));
        assert!(Access::Read.matches("RW"));
        assert!(!Access::Read.matches("WR"));
        assert!(Access::Write.matches("WR"));
        assert!(Access::Write.matches("RW"));
        assert!(!Access::Write.matches("RD"));
    }

    #[test]
    fn decodes_scalars_from_every_value_form() {
        assert_eq!(scalar_of(sdi::Value::from("0x1f")), Some(31));
        assert_eq!(scalar_of(sdi::Value::from("0b101")), Some(5));
        assert_eq!(scalar_of(sdi::Value::from("42")), Some(42));
        assert_eq!(scalar_of(sdi::Value::from("0xzz")), None);
    }
}
