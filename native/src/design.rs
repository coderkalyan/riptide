//! Source debug info, elaborated and indexed by trace path.
//!
//! An SDI file describes the *design*: definitions plus instances, with types,
//! enums and source spans. A trace names *signals*, by path. This module bridges
//! the two — it walks `design.roots` through each unit's instances exactly once at
//! load, and records what it learns under every trace path a variable could answer
//! to, so enriching the flattened hierarchy is a hash lookup per node.
//!
//! Everything here is optional and non-fatal. A trace with no SDI beside it, an
//! SDI from a different design, a version this build does not read: all of them
//! degrade to the VCD-grade tree rather than failing the open.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use sdi::{Direction, HintRole, Sdi, TypeKind, UnitKind};

/// Where a declaration is, with the file resolved to something openable.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Loc {
    pub file: String,
    pub line: u32,
}

/// What SDI adds to one signal in the tree.
#[derive(Clone, Debug, Default)]
pub struct VarFacts {
    /// The renderer's `VarType` spelling, derived from the declared keyword.
    pub var_type: Option<&'static str>,
    /// The renderer's `Direction` spelling. Absent means the trace's `implicit`.
    pub direction: Option<&'static str>,
    /// Display form of the declared type, e.g. `logic [7:0]` or `state_e`.
    pub type_name: Option<String>,
    /// Declared range, so the renderer stops parsing it out of the name.
    pub range: Option<(i64, i64)>,
    pub decl: Option<Loc>,
    pub comment: Option<String>,
    /// Index into [`Design::enums`], when the declared type is an enumeration.
    pub enum_type: Option<u32>,
    /// Producer's `hints.role`, in the renderer's `ActiveRole` spelling.
    ///
    /// This is what lets a trace align its grid to a clock without anyone hand-writing
    /// a view sidecar: the SDI already states which variable is the clock, so the
    /// renderer stops having to be told. Only the roles the renderer models are mapped;
    /// the rest stay `None` rather than inventing a spelling for them. A sidecar role
    /// always wins — hints are the tool's opinion, the sidecar is the user's.
    pub role: Option<&'static str>,
}

/// What SDI adds to one scope in the tree.
#[derive(Clone, Debug, Default)]
pub struct ScopeFacts {
    /// The renderer's `ScopeType`, which tide's four-way axis cannot express.
    pub scope_type: Option<&'static str>,
    /// Where the definition is — "go to definition".
    pub decl: Option<Loc>,
    /// Where this instance is created — "go to instantiation".
    pub inst: Option<Loc>,
    pub comment: Option<String>,
}

/// An int→label table in the shape the renderer's `EnumType` expects: values are
/// zero-padded binary strings, which is how both the existing formatter and FST's
/// own enum tables spell them.
#[derive(Clone, Debug)]
pub struct EnumTable {
    pub id: u32,
    pub name: String,
    pub members: Vec<(String, String)>,
}

pub struct Design {
    vars: HashMap<String, VarFacts>,
    scopes: HashMap<String, ScopeFacts>,
    pub enums: Vec<EnumTable>,
    /// Diagnostics worth surfacing rather than swallowing.
    pub notes: Vec<String>,
}

impl Design {
    pub fn var(&self, path: &str) -> Option<&VarFacts> {
        self.vars.get(path)
    }
    pub fn scope(&self, path: &str) -> Option<&ScopeFacts> {
        self.scopes.get(path)
    }
    pub fn len(&self) -> usize {
        self.vars.len()
    }

    /// Look for the SDI beside `trace`, honouring `RIPTIDE_SDI`. Returns `None`
    /// when there is nothing to load; `Some` with notes when something loaded but
    /// was imperfect.
    pub fn beside(trace: &Path) -> Option<Design> {
        let path = sdi_path(trace)?;
        match sdi::read(&path) {
            Ok(doc) => {
                let mut design = Design::from_doc(&doc, &path);
                let problems = sdi::validate(&doc);
                if !problems.is_empty() {
                    // A structurally broken file still enriches what it can; saying
                    // so beats silently showing partial data.
                    design.notes.push(format!(
                        "{}: {} structural problem(s), first: {}",
                        path.display(),
                        problems.len(),
                        problems[0]
                    ));
                }
                Some(design)
            }
            Err(error) => {
                // Not fatal: the trace opens VCD-grade.
                eprintln!("[sdi] {}: {error}", path.display());
                None
            }
        }
    }

    fn from_doc(doc: &Sdi, sdi_path: &Path) -> Design {
        let root_dir = doc
            .generator
            .as_ref()
            .and_then(|g| g.source_root.as_deref())
            .map(|r| {
                let r = Path::new(r);
                if r.is_absolute() {
                    r.to_path_buf()
                } else {
                    sdi_path.parent().unwrap_or(Path::new(".")).join(r)
                }
            })
            .unwrap_or_else(|| sdi_path.parent().unwrap_or(Path::new(".")).to_path_buf());

        // Files resolve to absolute paths now, so the renderer can hand one
        // straight to an editor without knowing where the SDI came from.
        let files: Vec<String> = doc
            .files
            .iter()
            .map(|f| {
                let p = Path::new(&*f.path);
                let joined = if p.is_absolute() { p.to_path_buf() } else { root_dir.join(p) };
                std::fs::canonicalize(&joined)
                    .unwrap_or(joined)
                    .to_string_lossy()
                    .into_owned()
            })
            .collect();

        let enums = enum_tables(doc);
        let mut walk = Walk {
            doc,
            files: &files,
            enums: &enums,
            vars: HashMap::new(),
            scopes: HashMap::new(),
            notes: Vec::new(),
        };

        let sep = doc.trace.as_ref().map(|t| t.separator()).unwrap_or(".");
        let prefix = doc
            .trace
            .as_ref()
            .and_then(|t| t.root_prefix.as_deref())
            .unwrap_or_default();
        let range_in_name = doc.trace.as_ref().is_some_and(|t| t.range_in_name);

        for root in &doc.design.roots {
            let base = if prefix.is_empty() {
                root.name.to_string()
            } else {
                format!("{prefix}{sep}{}", root.name)
            };
            // A root owns a scope in the trace like any instance does, and its kind
            // matters: the bundled mock's `derived` namespace is a package that VCD
            // can only spell as a module.
            if let Some(unit) = doc.unit(root.unit) {
                walk.scopes.insert(
                    base.clone(),
                    ScopeFacts {
                        scope_type: Some(scope_type(unit.kind)),
                        decl: walk.loc(unit.decl),
                        inst: walk.loc(root.decl),
                        comment: unit.comment.as_ref().map(|c| c.to_string()),
                    },
                );
            }
            walk.unit(root.unit, &base, sep, range_in_name, 0);
        }

        let (vars, scopes, notes) = (walk.vars, walk.scopes, walk.notes);
        Design { vars, scopes, enums, notes }
    }
}

/// `<trace>.sdi.json`, its gzipped sibling, or `$RIPTIDE_SDI`.
fn sdi_path(trace: &Path) -> Option<PathBuf> {
    if let Ok(explicit) = std::env::var("RIPTIDE_SDI") {
        let path = PathBuf::from(explicit);
        return path.is_file().then_some(path);
    }
    let mut base = trace.as_os_str().to_owned();
    base.push(".sdi.json");
    let plain = PathBuf::from(&base);
    if plain.is_file() {
        return Some(plain);
    }
    base.push(".gz");
    let gz = PathBuf::from(base);
    gz.is_file().then_some(gz)
}

/// Every enumeration in the type table, as an int→label map keyed by the type
/// index so a variable's `enumTypeId` is just that index.
fn enum_tables(doc: &Sdi) -> Vec<EnumTable> {
    let mut out = Vec::new();
    for (i, ty) in doc.types.iter().enumerate() {
        if ty.kind != TypeKind::Enum {
            continue;
        }
        let width = ty.width.unwrap_or(1).max(1) as usize;
        let members = ty
            .values
            .iter()
            .filter_map(|v| {
                let bits = binary_of(&v.value, width)?;
                Some((bits, v.name.to_string()))
            })
            .collect();
        out.push(EnumTable {
            id: i as u32,
            name: ty.name.as_deref().unwrap_or("enum").to_string(),
            members,
        });
    }
    out
}

/// An SDI value as a zero-padded binary string of `width` bits. Values that do
/// not fit, or carry unknown bits, are dropped rather than guessed at.
fn binary_of(value: &sdi::Value, width: usize) -> Option<String> {
    let text = match value {
        sdi::Value::Str(s) => s.as_ref(),
        sdi::Value::Num(n) if n.fract() == 0.0 && *n >= 0.0 => {
            return Some(format!("{:0width$b}", *n as u64, width = width));
        }
        _ => return None,
    };
    let n = if let Some(hex) = text.strip_prefix("0x") {
        u64::from_str_radix(hex, 16).ok()?
    } else if let Some(bin) = text.strip_prefix("0b") {
        u64::from_str_radix(bin, 2).ok()?
    } else {
        text.parse::<u64>().ok()?
    };
    Some(format!("{n:0width$b}"))
}

struct Walk<'a> {
    doc: &'a Sdi,
    files: &'a [String],
    enums: &'a [EnumTable],
    vars: HashMap<String, VarFacts>,
    scopes: HashMap<String, ScopeFacts>,
    notes: Vec<String>,
}

impl<'a> Walk<'a> {
    /// Record one scope and everything in it. `path` is the trace path of this
    /// scope; `inst_decl` is where it was instantiated, when it was.
    fn unit(&mut self, unit_idx: u32, path: &str, sep: &str, range_in_name: bool, depth: u32) {
        if depth > 64 {
            self.notes.push(format!("{path}: instance nesting deeper than 64, truncated"));
            return;
        }
        let Some(unit) = self.doc.unit(unit_idx) else {
            self.notes.push(format!("{path}: unit {unit_idx} is missing"));
            return;
        };

        for var in &unit.vars {
            let facts = self.facts(var);
            if !var.trace_signals.is_empty() {
                // One source variable the dumper split into several signals.
                for ts in &var.trace_signals {
                    self.vars.insert(format!("{path}{sep}{}", ts.path), facts.clone());
                }
                continue;
            }
            if var.trace_omitted {
                continue;
            }
            // Every spelling the trace might have used, cheapest first. The bare
            // name is the FST/glued-VCD case; the bracketed ones are what a VCD
            // writer produces for a vector.
            let mut leaves = Vec::with_capacity(3);
            if let Some(explicit) = &var.trace_name {
                leaves.push(explicit.to_string());
            }
            leaves.push(var.name.to_string());
            if range_in_name && var.trace_name.is_none() {
                if let Some((msb, lsb)) = facts.range {
                    leaves.push(format!("{}[{msb}:{lsb}]", var.name));
                    leaves.push(format!("{} [{msb}:{lsb}]", var.name));
                }
            }
            for leaf in leaves {
                self.vars.entry(format!("{path}{sep}{leaf}")).or_insert_with(|| facts.clone());
            }
        }

        for inst in &unit.instances {
            let child_path = if inst.inlined {
                path.to_string()
            } else {
                format!("{path}{sep}{}", inst.name)
            };
            if let Some(child) = inst.unit {
                let kind = self.doc.unit(child).map(|u| u.kind);
                self.scopes.insert(
                    child_path.clone(),
                    ScopeFacts {
                        scope_type: kind.map(scope_type),
                        decl: self.doc.unit(child).and_then(|u| self.loc(u.decl)),
                        inst: self.loc(inst.decl),
                        comment: self.doc.unit(child).and_then(|u| u.comment.as_ref()).map(|c| c.to_string()),
                    },
                );
                self.unit(child, &child_path, sep, range_in_name, depth + 1);
            } else {
                // A black box still owns a scope in the trace.
                self.scopes.insert(
                    child_path,
                    ScopeFacts { scope_type: Some("module"), inst: self.loc(inst.decl), ..Default::default() },
                );
            }
        }
    }

    /// Facts for one variable, resolving its type.
    fn facts(&self, var: &sdi::Var) -> VarFacts {
        let ty = self.doc.ty(var.ty);
        let resolved = self.resolve_alias(var.ty);
        let rty = self.doc.ty(resolved);
        VarFacts {
            var_type: rty.map(|t| var_type(t, var)),
            direction: var.direction.filter(|d| d.is_port()).map(direction),
            type_name: ty
                .and_then(|t| t.spelling.as_deref().or(t.name.as_deref()))
                .map(str::to_owned),
            range: rty.and_then(|t| range_of(t, self.doc.width_of(resolved))),
            decl: self.loc(var.decl),
            comment: var.comment.as_deref().map(str::to_owned),
            enum_type: rty
                .filter(|t| t.kind == TypeKind::Enum)
                .and_then(|_| self.enums.iter().find(|e| e.id == resolved).map(|e| e.id)),
            role: var.hints.as_ref().and_then(|h| h.role).and_then(hint_role),
        }
    }

    fn resolve_alias(&self, mut idx: u32) -> u32 {
        for _ in 0..32 {
            match self.doc.ty(idx) {
                Some(t) if t.kind == TypeKind::Alias => match t.target {
                    Some(next) => idx = next,
                    None => return idx,
                },
                _ => return idx,
            }
        }
        idx
    }

    fn loc(&self, span: Option<sdi::Span>) -> Option<Loc> {
        let span = span?;
        let file = self.files.get(span.file as usize)?;
        Some(Loc { file: file.clone(), line: span.line })
    }
}

/// The declared range, falling back to the flattened width so a vector still has
/// the `[msb:lsb]` a VCD writer would have glued onto its name.
fn range_of(ty: &sdi::Type, width: Option<u32>) -> Option<(i64, i64)> {
    if let Some([l, r]) = ty.range {
        return Some((l, r));
    }
    match width {
        Some(w) if w > 1 => Some((w as i64 - 1, 0)),
        _ => None,
    }
}

/// A declared type in the renderer's `VarType` vocabulary — the axis VCD destroys
/// by binning everything into `reg` and `wire`.
fn var_type(ty: &sdi::Type, var: &sdi::Var) -> &'static str {
    if ty.kind == TypeKind::Enum {
        return "sv_enum";
    }
    if ty.kind == TypeKind::Str {
        return "gen_string";
    }
    if ty.kind == TypeKind::Event {
        return "vcd_event";
    }
    if ty.kind == TypeKind::Real {
        return match ty.width {
            Some(32) => "sv_shortreal",
            _ => "vcd_real",
        };
    }
    match ty.keyword.as_deref() {
        Some("bit") => "sv_bit",
        Some("logic") => "sv_logic",
        Some("int") | Some("int unsigned") => "sv_int",
        Some("shortint") => "sv_shortint",
        Some("longint") => "sv_longint",
        Some("byte") => "sv_byte",
        Some("integer") => "vcd_integer",
        Some("time") => "vcd_time",
        Some("reg") => "vcd_reg",
        Some("wire") => "vcd_wire",
        Some("supply0") => "vcd_supply0",
        Some("supply1") => "vcd_supply1",
        Some("tri") => "vcd_tri",
        Some("triand") => "vcd_triand",
        Some("trior") => "vcd_trior",
        Some("tri0") => "vcd_tri0",
        Some("tri1") => "vcd_tri1",
        // No declared keyword: fall back to how it is driven, which is what the
        // trace would have said anyway.
        _ => match var.kind {
            Some(sdi::VarKind::Net) => "vcd_wire",
            Some(sdi::VarKind::Param) => "vcd_parameter",
            _ => "vcd_reg",
        },
    }
}

fn direction(d: Direction) -> &'static str {
    match d {
        Direction::Input => "input",
        Direction::Output => "output",
        Direction::Inout => "inout",
        // The renderer's vocabulary is FST's, which has no `ref`; `linkage` is the
        // closest thing it offers for a by-reference port.
        Direction::Ref => "linkage",
        Direction::Internal => "implicit",
    }
}

/// SDI's role hints in the renderer's `ActiveRole` vocabulary.
///
/// Only the three the renderer actually models are mapped. `Enable`, `Ready` and the
/// `Data` fallback deliberately yield `None`: the renderer would have to invent a
/// meaning for them, and `HintRole` falls back to `Data` for anything it does not
/// recognise, so mapping it would turn every unknown role into a real one.
fn hint_role(role: HintRole) -> Option<&'static str> {
    match role {
        HintRole::Clock => Some("clock"),
        HintRole::Reset => Some("reset"),
        HintRole::Valid => Some("valid"),
        HintRole::Enable | HintRole::Ready | HintRole::Data => None,
    }
}

/// SDI's scope kinds in the renderer's `ScopeType` vocabulary. tide's four-way
/// axis cannot tell a package from a module, which is the shim this removes.
fn scope_type(kind: UnitKind) -> &'static str {
    match kind {
        UnitKind::Module | UnitKind::Udp | UnitKind::BlackBox | UnitKind::Other => "module",
        UnitKind::Interface => "interface",
        UnitKind::Program => "program",
        UnitKind::Package => "package",
        UnitKind::Class => "class",
        UnitKind::GenBlock => "generate",
        UnitKind::Block => "begin",
        UnitKind::Function => "function",
        UnitKind::Task => "task",
        UnitKind::StructScope => "struct",
        UnitKind::ArrayScope => "sv_array",
        UnitKind::VhdlArchitecture => "vhdl_architecture",
        UnitKind::VhdlProcess => "vhdl_process",
        UnitKind::VhdlBlock => "vhdl_block",
        UnitKind::VhdlGenerate => "vhdl_generate",
        UnitKind::VhdlPackage => "vhdl_package",
        UnitKind::VhdlRecord => "vhdl_record",
        UnitKind::VhdlProcedure => "vhdl_procedure",
        UnitKind::VhdlFunction => "vhdl_function",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mock() -> Design {
        let trace = Path::new(env!("CARGO_MANIFEST_DIR")).join("src/mock.vcd");
        Design::beside(&trace).expect("the bundled mock ships an SDI")
    }

    #[test]
    fn finds_the_sdi_beside_the_bundled_mock() {
        let design = mock();
        assert!(design.notes.is_empty(), "{:?}", design.notes);
        assert!(design.len() >= 36, "indexed only {} paths", design.len());
    }

    #[test]
    fn indexes_vectors_under_the_glued_spelling_the_vcd_uses() {
        let design = mock();
        // mock.vcd writes `$var wire 11 # c[10:0]`, so tide's leaf name is glued.
        let c = design.var("top.keysched.c[10:0]").expect("c[10:0]");
        assert_eq!(c.var_type, Some("sv_logic"));
        assert_eq!(c.direction, Some("input"));
        assert_eq!(c.range, Some((10, 0)));
        // Ascending ranges survive as declared.
        let load1 = design.var("top.keysched.load1[0:8]").expect("load1[0:8]");
        assert_eq!(load1.range, Some((0, 8)));
        // A scalar has no bracketed spelling at all.
        assert!(design.var("top.keysched.clk").is_some());
    }

    #[test]
    fn carries_declarations_and_doc_comments() {
        let design = mock();
        let rst_n = design.var("top.keysched.rst_n").expect("rst_n");
        assert_eq!(rst_n.comment.as_deref(), Some("active-low reset"));
        let decl = rst_n.decl.as_ref().expect("a declaration site");
        assert!(decl.file.ends_with("mock.sv"), "{}", decl.file);
        assert!(decl.line > 1);
        assert!(Path::new(&decl.file).is_file(), "the decl path must be openable");
    }

    #[test]
    fn resolves_enums_to_binary_keyed_tables() {
        let design = mock();
        let state = design.var("top.keysched.waves.state[1:0]").expect("waves.state");
        assert_eq!(state.var_type, Some("sv_enum"));
        let id = state.enum_type.expect("an enum type");
        let table = design.enums.iter().find(|e| e.id == id).expect("the table");
        assert_eq!(table.name, "state_e");
        assert_eq!(
            table.members,
            vec![
                ("00".to_string(), "IDLE".to_string()),
                ("01".to_string(), "BUSY".to_string()),
                ("10".to_string(), "WAIT".to_string()),
            ]
        );
    }

    #[test]
    fn names_scope_kinds_tide_cannot() {
        let design = mock();
        // The VCD declares `derived` as a module because tide's axis has no package;
        // SDI knows better, which is what removes that shim from the renderer.
        assert_eq!(design.scope("derived").and_then(|s| s.scope_type), Some("package"));
        assert_eq!(design.scope("top").and_then(|s| s.scope_type), Some("module"));
        let waves = design.scope("top.keysched.waves").expect("waves scope");
        assert_eq!(waves.scope_type, Some("module"));
        assert!(waves.decl.is_some(), "a module definition has a site");
        assert!(waves.inst.is_some(), "and so does its instantiation");
        assert_eq!(waves.comment.as_deref(), Some("The signals the bundled view puts on screen."));
    }

    #[test]
    fn reads_role_hints_so_a_clock_needs_no_hand_written_sidecar() {
        let design = mock();
        // The regression this guards: without these, "Align Grid to Clock" is dead on
        // any trace whose roles are not spelled out in a view sidecar, even though the
        // SDI beside it says outright which variable is the clock.
        assert_eq!(design.var("top.keysched.waves.clk").and_then(|v| v.role), Some("clock"));
        assert_eq!(design.var("top.keysched.clk").and_then(|v| v.role), Some("clock"));
        assert_eq!(design.var("top.keysched.waves.rst").and_then(|v| v.role), Some("reset"));
        assert_eq!(design.var("top.keysched.rst_n").and_then(|v| v.role), Some("reset"));
        // A variable the producer said nothing about stays roleless — no guessing from
        // names, which is the whole point of the hint being explicit.
        let state = design.var("top.keysched.waves.state[1:0]").expect("waves.state");
        assert_eq!(state.role, None);
    }

    #[test]
    fn maps_only_the_roles_the_renderer_models() {
        assert_eq!(hint_role(HintRole::Clock), Some("clock"));
        assert_eq!(hint_role(HintRole::Reset), Some("reset"));
        assert_eq!(hint_role(HintRole::Valid), Some("valid"));
        // `HintRole` parses unknown strings as `Data`, so Data MUST stay unmapped: map
        // it and every role a future SDI invents silently becomes a real one here.
        assert_eq!(hint_role(HintRole::Data), None);
        assert_eq!(hint_role(HintRole::Enable), None);
        assert_eq!(hint_role(HintRole::Ready), None);
    }

    #[test]
    fn a_trace_with_no_sdi_is_not_an_error() {
        let missing = Path::new("/nonexistent/nowhere.vcd");
        assert!(Design::beside(missing).is_none());
    }

    #[test]
    fn binary_conversion_pads_and_rejects_unknowns() {
        assert_eq!(binary_of(&sdi::Value::from("0x3"), 2).as_deref(), Some("11"));
        assert_eq!(binary_of(&sdi::Value::from("0x1"), 4).as_deref(), Some("0001"));
        assert_eq!(binary_of(&sdi::Value::from("2"), 3).as_deref(), Some("010"));
        assert_eq!(binary_of(&sdi::Value::from("0b101"), 3).as_deref(), Some("101"));
        // x/z cannot be a label key, so it is dropped rather than guessed.
        assert_eq!(binary_of(&sdi::Value::from("0bx1"), 2), None);
    }
}
