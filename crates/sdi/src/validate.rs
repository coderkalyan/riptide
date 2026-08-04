//! The invariants a JSON Schema cannot express.
//!
//! `docs/sdi.schema.json` checks shapes: which keys exist, their types, which enum
//! members are legal. It cannot check that an index points at something, that a bit
//! slice fits inside its variable, or that a `ref.up` hop does not try to cross a
//! module boundary. Those are cross-references, and they are exactly the mistakes a
//! producer makes. Validating them here means both the producer and the future
//! importer get the same answer from the same code.

use std::collections::HashSet;

use crate::enums::{Direction, TypeKind, UnitKind};
use crate::model::{Ref, Sdi, Span, Target, Unit};

/// One structural problem, with a path a producer author can act on.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Problem {
    pub at: String,
    pub message: String,
}

impl std::fmt::Display for Problem {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.at, self.message)
    }
}

/// Check every cross-reference in the file. An empty result means the file is
/// internally consistent — it says nothing about whether it matches a trace.
pub fn validate(sdi: &Sdi) -> Vec<Problem> {
    let mut v = Validator { sdi, problems: Vec::new() };
    v.run();
    v.problems
}

struct Validator<'a> {
    sdi: &'a Sdi,
    problems: Vec<Problem>,
}

impl<'a> Validator<'a> {
    fn bad(&mut self, at: impl Into<String>, message: impl Into<String>) {
        self.problems.push(Problem { at: at.into(), message: message.into() });
    }

    fn run(&mut self) {
        if self.sdi.version != crate::VERSION {
            self.bad("$", format!("version {} is not 1", self.sdi.version));
        }
        self.check_files();
        self.check_types();
        for (ui, unit) in self.sdi.units.iter().enumerate() {
            self.check_unit(ui, unit);
        }
        self.check_roots();
    }

    fn check_files(&mut self) {
        for (i, f) in self.sdi.files.iter().enumerate() {
            if let Some(h) = &f.blake3
                && (h.len() != 64 || !h.bytes().all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase()))
            {
                self.bad(format!("files[{i}]"), "blake3 is not 64 lowercase hex digits");
            }
        }
    }

    fn check_span(&mut self, at: &str, span: Option<Span>) {
        if let Some(s) = span {
            if s.file as usize >= self.sdi.files.len() {
                self.bad(at, format!("span names missing file {}", s.file));
            }
            if s.line == 0 {
                self.bad(at, "span line is 0; lines are 1-based");
            }
            if s.end_line != 0 && s.end_line < s.line {
                self.bad(at, "span ends before it starts");
            }
        }
    }

    fn check_types(&mut self) {
        let n = self.sdi.types.len() as u32;
        for i in 0..self.sdi.types.len() {
            let t = &self.sdi.types[i];
            let at = format!("types[{i}]");
            let decl = t.decl;
            self.check_span(&at, decl);

            for (label, idx) in [("base", t.base), ("elem", t.elem), ("keyType", t.key_type), ("target", t.target)] {
                if let Some(r) = idx
                    && r >= n
                {
                    self.bad(&at, format!("{label} -> types[{r}] missing"));
                }
            }
            if let Some(u) = t.unit
                && u as usize >= self.sdi.units.len()
            {
                self.bad(&at, format!("unit -> units[{u}] missing"));
            }

            if t.kind.needs_width() && t.width.is_none() {
                self.bad(&at, format!("{} requires a width", t.kind));
            }
            match t.kind {
                TypeKind::Enum => {
                    if t.base.is_none() {
                        self.bad(&at, "enum requires a base type");
                    }
                    if t.values.is_empty() {
                        self.bad(&at, "enum has no values");
                    }
                }
                TypeKind::Alias if t.target.is_none() => self.bad(&at, "alias requires a target"),
                TypeKind::PackedArray | TypeKind::UnpackedArray if t.elem.is_none() => {
                    self.bad(&at, format!("{} requires an elem type", t.kind));
                }
                TypeKind::Struct | TypeKind::Union => {
                    let width = t.width;
                    for m in t.members.clone() {
                        let mat = format!("{at}.members[{}]", m.name);
                        if m.ty >= n {
                            self.bad(&mat, format!("type -> types[{}] missing", m.ty));
                            continue;
                        }
                        self.check_span(&mat, m.decl);
                        if t.packed {
                            match (m.lsb, self.sdi.width_of(m.ty), width) {
                                (None, _, _) => self.bad(&mat, "packed member has no lsb"),
                                (Some(lsb), Some(mw), Some(w)) if lsb + mw > w => self.bad(
                                    &mat,
                                    format!("member at lsb {lsb} + {mw}b exceeds the {w}b parent"),
                                ),
                                _ => {}
                            }
                        }
                    }
                }
                _ => {}
            }
            for val in t.values.clone() {
                self.check_span(&format!("{at}.values[{}]", val.name), val.decl);
            }
        }
    }

    fn check_unit(&mut self, ui: usize, unit: &Unit) {
        let at = format!("units[{ui}] ({})", unit.name);
        self.check_span(&at, unit.decl);
        self.check_span(&at, unit.body);

        let mut seen_ports = HashSet::new();
        for (k, &p) in unit.ports.iter().enumerate() {
            match unit.vars.get(p as usize) {
                None => self.bad(&at, format!("ports[{k}] -> vars[{p}] missing")),
                Some(v) => {
                    if !v.direction.is_some_and(Direction::is_port) {
                        self.bad(&at, format!("ports[{k}] ({}) has no direction", v.name));
                    }
                    if !seen_ports.insert(p) {
                        self.bad(&at, format!("vars[{p}] ({}) is listed as a port twice", v.name));
                    }
                }
            }
        }

        for (vi, var) in unit.vars.iter().enumerate() {
            let vat = format!("{at}.vars[{vi}] ({})", var.name);
            if var.ty as usize >= self.sdi.types.len() {
                self.bad(&vat, format!("type -> types[{}] missing", var.ty));
            }
            self.check_span(&vat, var.decl);
            if let Some(w) = self.sdi.width_of(var.ty) {
                for ts in &var.trace_signals {
                    if let Some(b) = ts.bits
                        && b.width != 0
                        && b.lsb + b.width > w
                    {
                        self.bad(&vat, format!("traceSignals {} exceeds the {w}b variable", ts.path));
                    }
                }
            }
            if var.trace_omitted && !var.trace_signals.is_empty() {
                self.bad(&vat, "traceOmitted contradicts traceSignals");
            }
        }

        for (ii, inst) in unit.instances.iter().enumerate() {
            let iat = format!("{at}.instances[{ii}] ({})", inst.name);
            self.check_span(&iat, inst.decl);
            match inst.unit {
                None if !inst.black_box => self.bad(&iat, "has neither a unit nor blackBox"),
                Some(u) if u as usize >= self.sdi.units.len() => {
                    self.bad(&iat, format!("unit -> units[{u}] missing"));
                }
                _ => {}
            }
            for (ci, conn) in inst.conns.iter().enumerate() {
                let cat = format!("{iat}.conns[{ci}]");
                self.check_span(&cat, conn.loc);
                if let (Some(child), Some(port)) = (inst.unit, conn.port) {
                    let ports = self.sdi.unit(child).map(|u| u.ports.len()).unwrap_or(0);
                    if port as usize >= ports {
                        self.bad(&cat, format!("port ordinal {port} is out of range ({ports} ports)"));
                    }
                }
                for r in conn.reads.iter().chain(&conn.writes) {
                    self.check_ref(&cat, ui, r);
                }
            }
        }

        for (pi, proc) in unit.processes.iter().enumerate() {
            let pat = format!("{at}.processes[{pi}] ({})", proc.kind);
            self.check_span(&pat, proc.loc);
            for s in &proc.sense {
                self.check_ref(&pat, ui, &s.reference);
            }
            for r in &proc.reads {
                self.check_ref(&pat, ui, r);
            }
            for (ai, a) in proc.assigns.iter().enumerate() {
                let aat = format!("{pat}.assigns[{ai}]");
                self.check_span(&aat, a.loc);
                if a.targets.is_empty() {
                    self.bad(&aat, "has no targets");
                }
                for r in a.targets.iter().chain(&a.sources) {
                    self.check_ref(&aat, ui, r);
                }
            }
        }
    }

    /// Resolve a reference the way a consumer does, and report where it breaks.
    fn check_ref(&mut self, at: &str, home: usize, r: &Ref) {
        self.check_span(at, r.loc);

        // `up` walks out through block-like scopes only. Without an elaborated tree
        // the exact parent is unknown here, so check what is checkable: a hop out of
        // a non-block unit can never be resolved by any consumer.
        if r.up > 0 {
            let kind = self.sdi.units[home].kind;
            if !kind.is_block() {
                self.bad(
                    at,
                    format!("up:{} from a {kind} unit, which no consumer can cross", r.up),
                );
                return;
            }
        }

        match &r.target {
            Target::Var(v) => {
                if r.up == 0 {
                    let unit = &self.sdi.units[home];
                    match unit.vars.get(*v as usize) {
                        None => self.bad(at, format!("var -> vars[{v}] missing in {}", unit.name)),
                        Some(var) => {
                            if let (Some(b), Some(w)) = (r.bits, self.sdi.width_of(var.ty))
                                && b.width != 0
                                && b.lsb + b.width > w
                            {
                                self.bad(
                                    at,
                                    format!(
                                        "slice [{}+{}] exceeds the {w}b variable {}",
                                        b.lsb, b.width, var.name
                                    ),
                                );
                            }
                        }
                    }
                }
            }
            Target::Port { inst, port } => {
                let unit = &self.sdi.units[home];
                match unit.instances.get(*inst as usize) {
                    None => self.bad(at, format!("inst -> instances[{inst}] missing")),
                    Some(i) => {
                        if let Some(child) = i.unit {
                            let ports = self.sdi.unit(child).map(|u| u.ports.len()).unwrap_or(0);
                            if *port as usize >= ports {
                                self.bad(at, format!("port ordinal {port} out of range"));
                            }
                        }
                    }
                }
            }
            Target::Xmr(path) => {
                if path.is_empty() {
                    self.bad(at, "xmr path is empty");
                }
            }
        }
    }

    fn check_roots(&mut self) {
        if self.sdi.design.roots.is_empty() {
            self.bad("design", "has no roots");
        }
        for (i, root) in self.sdi.design.roots.iter().enumerate() {
            let at = format!("design.roots[{i}] ({})", root.name);
            if root.unit as usize >= self.sdi.units.len() {
                self.bad(&at, format!("unit -> units[{}] missing", root.unit));
            }
            self.check_span(&at, root.decl);
            if root.name.is_empty() {
                self.bad(&at, "root name is empty");
            }
        }
        // A root whose unit is a block kind cannot be a design top.
        for root in self.sdi.design.roots.clone() {
            if let Some(u) = self.sdi.unit(root.unit)
                && u.kind.is_block()
            {
                self.bad(
                    format!("design.roots ({})", root.name),
                    format!("points at a {} unit, which is a scope inside something else", u.kind),
                );
            }
        }
        let _ = UnitKind::Module;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::enums::*;
    use crate::model::*;

    fn minimal() -> Sdi {
        let mut sdi = Sdi::new(Design {
            name: None,
            language: None,
            roots: vec![Root { name: "dut".into(), unit: 0, decl: None }],
        });
        sdi.files.push(SourceFile {
            path: "top.sv".into(),
            real_path: None,
            language: None,
            blake3: None,
        });
        sdi.types.push(Type::bits("logic", 8, 4));
        let mut u = Unit::new(UnitKind::Module, "top");
        u.vars.push(Var::new("a", 0));
        sdi.units.push(u);
        sdi
    }

    #[test]
    fn a_minimal_file_is_clean() {
        assert_eq!(validate(&minimal()), vec![]);
    }

    #[test]
    fn catches_dangling_indices() {
        let mut sdi = minimal();
        sdi.units[0].vars[0].ty = 9;
        let problems = validate(&sdi);
        assert!(problems.iter().any(|p| p.message.contains("types[9] missing")), "{problems:?}");
    }

    #[test]
    fn catches_slices_past_the_end_of_a_variable() {
        let mut sdi = minimal();
        let mut p = Process::new(ProcessKind::ContAssign);
        p.assigns.push(Assign {
            loc: None,
            targets: vec![Ref::var(0).with_bits(Some(Bits::new(4, 8)))], // 4+8 > 8
            sources: vec![],
            non_blocking: false,
            delay: None,
            guarded: false,
            text: None,
        });
        sdi.units[0].processes.push(p);
        let problems = validate(&sdi);
        assert!(problems.iter().any(|p| p.message.contains("exceeds the 8b variable")), "{problems:?}");
    }

    #[test]
    fn allows_a_zero_width_slice_of_anything() {
        let mut sdi = minimal();
        let mut p = Process::new(ProcessKind::ContAssign);
        p.assigns.push(Assign {
            loc: None,
            targets: vec![Ref::var(0).with_bits(Some(Bits::new(8, 0)))],
            sources: vec![],
            non_blocking: false,
            delay: None,
            guarded: false,
            text: None,
        });
        sdi.units[0].processes.push(p);
        assert_eq!(validate(&sdi), vec![]);
    }

    #[test]
    fn catches_an_up_hop_out_of_a_module() {
        let mut sdi = minimal();
        let mut p = Process::new(ProcessKind::AlwaysComb);
        p.assigns.push(Assign {
            loc: None,
            targets: vec![Ref::var(0).with_up(1)],
            sources: vec![],
            non_blocking: false,
            delay: None,
            guarded: false,
            text: None,
        });
        sdi.units[0].processes.push(p);
        let problems = validate(&sdi);
        assert!(problems.iter().any(|p| p.message.contains("no consumer can cross")), "{problems:?}");
    }

    #[test]
    fn catches_a_port_with_no_direction() {
        let mut sdi = minimal();
        sdi.units[0].ports.push(0);
        let problems = validate(&sdi);
        assert!(problems.iter().any(|p| p.message.contains("has no direction")), "{problems:?}");
    }

    #[test]
    fn catches_a_packed_member_that_does_not_fit() {
        let mut sdi = minimal();
        let mut t = Type::of(TypeKind::Struct);
        t.packed = true;
        t.width = Some(8);
        t.members.push(Member {
            name: "hi".into(),
            ty: 0,
            lsb: Some(4),
            decl: None,
            comment: None,
            value: None,
        });
        sdi.types.push(t);
        let problems = validate(&sdi);
        assert!(problems.iter().any(|p| p.message.contains("exceeds the 8b parent")), "{problems:?}");
    }

    #[test]
    fn catches_contradictory_trace_binding() {
        let mut sdi = minimal();
        sdi.units[0].vars[0].trace_omitted = true;
        sdi.units[0].vars[0].trace_signals.push(TraceSignal {
            path: "a[0]".into(),
            bits: None,
            member: None,
        });
        let problems = validate(&sdi);
        assert!(problems.iter().any(|p| p.message.contains("contradicts")), "{problems:?}");
    }
}
