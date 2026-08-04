//! Verilator dtypes to SDI types — and the arithmetic Verilator refuses to do.
//!
//! The dump carries **no widths anywhere**: an exhaustive grep of `V3AstNodes.cpp`
//! finds width-bearing JSON emission only on `AstSel`. No `width`, no `msb`, no
//! `elements`, and no packed-struct member offsets. So this module owns the keyword
//! table, the range arithmetic and the struct summation. Getting it wrong
//! desynchronises against the trace's sample width, which is why it is unit-tested
//! rather than eyeballed.

use std::collections::HashMap;

use sdi::{ArrayShape, EnumValue, Member, Sdi, Type, TypeKind, Value};

use crate::ast::{Ast, NodeId, Str};
use crate::source::Sources;

/// `keyword -> (width, states)`. `states: None` means the type has no logic-value
/// count (a real, a string, an event). SystemVerilog `integer` is 4-state while
/// `int` is 2-state — the distinction VCD destroys and the reason this table exists.
const KEYWORDS: &[(&str, Option<u32>, Option<u8>)] = &[
    ("logic", Some(1), Some(4)),
    ("bit", Some(1), Some(2)),
    ("reg", Some(1), Some(4)),
    ("wire", Some(1), Some(4)),
    ("byte", Some(8), Some(2)),
    ("shortint", Some(16), Some(2)),
    ("int", Some(32), Some(2)),
    ("longint", Some(64), Some(2)),
    ("integer", Some(32), Some(4)),
    ("time", Some(64), Some(4)),
    ("real", Some(64), None),
    ("shortreal", Some(32), None),
    ("double", Some(64), None),
    ("string", None, None),
    ("chandle", Some(64), None),
    ("event", None, None),
    ("void", None, None),
    ("logic_implicit", Some(1), Some(4)),
];

/// Keywords whose declared form is signed unless said otherwise.
const SIGNED_BY_DEFAULT: &[&str] = &["byte", "shortint", "int", "longint", "integer"];

fn keyword_facts(kw: &str) -> (Option<u32>, Option<u8>) {
    for (name, width, states) in KEYWORDS {
        if *name == kw {
            return (*width, *states);
        }
    }
    (None, Some(4))
}

pub struct Types {
    /// Verilator dtype `addr` -> index into `Sdi::types`.
    by_addr: HashMap<String, u32>,
}

impl Types {
    pub fn new() -> Self {
        Self { by_addr: HashMap::new() }
    }

    /// Intern the type a pointer field names, resolving the transparent wrappers
    /// Verilator inserts (`REFDTYPE`, `CONSTDTYPE`) so a `state_e` port lands on the
    /// enum itself rather than on a forwarding node.
    pub fn intern(
        &mut self,
        ast: &Ast<'_>,
        out: &mut Sdi,
        src: &mut Sources,
        notes: &mut Vec<String>,
        addr: Option<&Str<'_>>,
    ) -> Option<u32> {
        let node = self.resolve(ast, ast.at(addr)?)?;
        let key = ast.node(node).addr.to_string();
        if let Some(hit) = self.by_addr.get(&key) {
            return Some(*hit);
        }
        // Reserve before recursing so a recursive type terminates.
        let idx = out.types.len() as u32;
        out.types.push(Type::of(TypeKind::Opaque));
        self.by_addr.insert(key, idx);
        let built = self.build(ast, out, src, notes, node);
        out.types[idx as usize] = built;
        Some(idx)
    }

    fn resolve(&self, ast: &Ast<'_>, mut id: NodeId) -> Option<NodeId> {
        for _ in 0..32 {
            let node = ast.node(id);
            if node.ty != "REFDTYPE" && node.ty != "CONSTDTYPE" {
                return Some(id);
            }
            let next = ast
                .at(node.ref_dtypep.as_ref())
                .or_else(|| ast.at(node.dtypep.as_ref()))?;
            if next == id {
                return Some(id);
            }
            id = next;
        }
        None
    }

    fn build(
        &mut self,
        ast: &Ast<'_>,
        out: &mut Sdi,
        src: &mut Sources,
        notes: &mut Vec<String>,
        id: NodeId,
    ) -> Type {
        let node = ast.node(id);
        let decl = src.span(&node.loc);
        let comment = decl.and_then(|d| src.doc_comment(d));

        let mut t = match node.ty.as_ref() {
            "BASICDTYPE" => {
                let kw = node.keyword.as_deref().unwrap_or("logic").to_ascii_lowercase();
                let (kw_width, states) = keyword_facts(&kw);
                let range = node
                    .range
                    .as_deref()
                    .and_then(parse_colon_range)
                    .or_else(|| child_range(ast, id));
                let width = range
                    .map(|[l, r]| (l - r).unsigned_abs() as u32 + 1)
                    .or(kw_width);

                match kw.as_str() {
                    "real" | "shortreal" | "double" => {
                        let mut t = Type::of(TypeKind::Real);
                        t.keyword = Some(if kw == "double" { "real".into() } else { kw.clone().into() });
                        t.width = Some(width.unwrap_or(64));
                        t
                    }
                    "string" => {
                        let mut t = Type::of(TypeKind::Str);
                        t.keyword = Some(kw.clone().into());
                        t
                    }
                    "event" | "void" | "chandle" => {
                        let mut t = Type::of(match kw.as_str() {
                            "event" => TypeKind::Event,
                            "void" => TypeKind::Void,
                            _ => TypeKind::Chandle,
                        });
                        t.keyword = Some(kw.clone().into());
                        t
                    }
                    _ => match width {
                        Some(w) => {
                            let mut t = Type::bits(&kw, w, states.unwrap_or(4));
                            t.signed = node.flags.signed() || SIGNED_BY_DEFAULT.contains(&kw.as_str());
                            // Only a keyword that is 1 bit on its own gains meaning from a
                                // declared range: `int` is 32 bits by definition, and
                                // spelling it `int [31:0]` would be wrong.
                            if let Some(r) = range
                                && w > 1
                                && kw_width == Some(1)
                            {
                                t.range = Some(r);
                                t.spelling = Some(format!("{kw} [{}:{}]", r[0], r[1]).into());
                            }
                            t
                        }
                        None => {
                            notes.push(format!("unmodelled BASICDTYPE keyword \"{kw}\", emitted as opaque"));
                            let mut t = Type::of(TypeKind::Opaque);
                            t.keyword = Some(kw.clone().into());
                            t.note = Some("width unknown to the producer".into());
                            t
                        }
                    },
                }
            }

            "ENUMDTYPE" => {
                let base = self.intern(ast, out, src, notes, node.ref_dtypep.as_ref());
                let mut values = Vec::new();
                for item in ast.kids(id, "itemsp") {
                    let item_node = ast.node(*item);
                    let value = ast
                        .kid(*item, "valuep")
                        .and_then(|v| const_value(ast, v))
                        .unwrap_or_else(|| Value::from("0x0"));
                    let vdecl = src.span(&item_node.loc);
                    values.push(EnumValue {
                        name: item_node.name.as_ref().into(),
                        value,
                        decl: vdecl,
                        comment: None,
                    });
                }
                let mut t = Type::of(TypeKind::Enum);
                t.base = base;
                t.width = base.and_then(|b| out.width_of(b)).or(Some(1));
                t.states = base.and_then(|b| out.ty(b).and_then(|x| x.states));
                t.values = values;
                t
            }

            "STRUCTDTYPE" | "UNIONDTYPE" => {
                let mut members = Vec::new();
                let mut widths = Vec::new();
                for m in ast.kids(id, "membersp") {
                    let mn = ast.node(*m);
                    let ty = self
                        .intern(ast, out, src, notes, mn.ref_dtypep.as_ref().or(mn.dtypep.as_ref()));
                    let Some(ty) = ty else { continue };
                    let mdecl = src.span(&mn.loc);
                    widths.push(out.width_of(ty).unwrap_or(0));
                    members.push(Member {
                        name: mn.name.as_ref().into(),
                        ty,
                        lsb: None,
                        decl: mdecl,
                        comment: mdecl.and_then(|d| src.doc_comment(d)),
                        value: None,
                    });
                }
                let total: u32 = widths.iter().sum();
                let packed = node.flags.packed();
                if packed {
                    // Verilator emits no offsets. In a packed struct the first member
                    // is most significant, so offsets descend from the top.
                    let mut lsb = total;
                    for (m, w) in members.iter_mut().zip(&widths) {
                        lsb -= w;
                        m.lsb = Some(lsb);
                    }
                }
                let mut t = Type::of(if node.ty == "UNIONDTYPE" {
                    TypeKind::Union
                } else {
                    TypeKind::Struct
                });
                t.packed = packed;
                t.tagged = node.flags.tagged();
                t.width = Some(total);
                if node.flags.four_state() {
                    t.states = Some(4);
                }
                t.members = members;
                t
            }

            "PACKARRAYDTYPE" | "UNPACKARRAYDTYPE" => {
                let elem = self.intern(ast, out, src, notes, node.ref_dtypep.as_ref());
                let range = node
                    .decl_range
                    .as_deref()
                    .and_then(parse_bracket_range)
                    .or_else(|| child_range(ast, id));
                let packed = node.ty == "PACKARRAYDTYPE";
                let mut t = Type::of(if packed {
                    TypeKind::PackedArray
                } else {
                    TypeKind::UnpackedArray
                });
                t.elem = elem;
                t.range = range;
                if !packed {
                    t.shape = Some(ArrayShape::Fixed);
                }
                if let (Some([l, r]), Some(ew)) = (range, elem.and_then(|e| out.width_of(e))) {
                    let count = (l - r).unsigned_abs() as u32 + 1;
                    t.width = Some(count * ew);
                    let inner = elem
                        .and_then(|e| out.ty(e))
                        .map(|x| x.display_name().to_string())
                        .unwrap_or_default();
                    t.spelling = Some(format!("{inner} [{l}:{r}]").into());
                }
                t
            }

            "VOIDDTYPE" => Type::of(TypeKind::Void),

            "IFACEREFDTYPE" => {
                let mut t = Type::of(TypeKind::Interface);
                t.keyword = Some("interface".into());
                t.modport = node.modport_name.as_deref().map(Into::into);
                t
            }

            "CLASSREFDTYPE" => {
                let mut t = Type::of(TypeKind::Class);
                t.keyword = Some("class".into());
                t
            }

            other => {
                notes.push(format!("unmodelled dtype {other}, emitted as opaque"));
                let mut t = Type::of(TypeKind::Opaque);
                t.note = Some(format!("verilator {other}").into());
                t
            }
        };

        // Verilator names a package-scoped type `pkg::state_e`; SDI wants the bare
        // name for display and keeps the qualified form as the spelling.
        if !node.name.is_empty() {
            let full = node.name.as_ref();
            t.name = Some(full.rsplit("::").next().unwrap_or(full).into());
            if t.spelling.is_none() {
                t.spelling = Some(full.into());
            }
        }
        t.decl = decl;
        if t.comment.is_none() {
            t.comment = comment;
        }
        t
    }
}

/// `"7:0"` from `BASICDTYPE.range`.
fn parse_colon_range(text: &str) -> Option<[i64; 2]> {
    let (l, r) = text.split_once(':')?;
    Some([l.trim().parse().ok()?, r.trim().parse().ok()?])
}

/// `"[3:0]"` from `declRange` on an array.
fn parse_bracket_range(text: &str) -> Option<[i64; 2]> {
    parse_colon_range(text.trim().strip_prefix('[')?.strip_suffix(']')?)
}

/// A `RANGE` child, used when the bounds were not constant-folded into a string.
fn child_range(ast: &Ast<'_>, id: NodeId) -> Option<[i64; 2]> {
    let range = ast.kid(id, "rangep")?;
    let left = const_int(ast, ast.kid(range, "leftp")?)?;
    let right = const_int(ast, ast.kid(range, "rightp")?)?;
    Some([left, right])
}

/// A Verilog literal from `CONST.name`, as an SDI [`Value`].
pub fn const_value(ast: &Ast<'_>, id: NodeId) -> Option<Value> {
    let node = ast.node(id);
    if node.ty != "CONST" {
        return None;
    }
    Some(literal(&node.name))
}

fn const_int(ast: &Ast<'_>, id: NodeId) -> Option<i64> {
    match const_value(ast, id)? {
        Value::Str(s) => parse_scalar(&s),
        Value::Num(n) => Some(n as i64),
        Value::Bool(b) => Some(b as i64),
    }
}

fn parse_scalar(text: &str) -> Option<i64> {
    if let Some(hex) = text.strip_prefix("0x") {
        i64::from_str_radix(hex, 16).ok()
    } else if let Some(bin) = text.strip_prefix("0b") {
        i64::from_str_radix(bin, 2).ok()
    } else {
        text.parse().ok()
    }
}

/// Convert `<width>'<s?><base><digits>` into SDI's canonical value encoding: `0x…`
/// or `0b…` when the bits matter, plain decimal when they do not. Verilator emits
/// constants only as these strings, so this is the only decoder in the pipeline.
pub fn literal(text: &str) -> Value {
    let Some((_, rest)) = text.split_once('\'') else {
        return Value::from(text);
    };
    let rest = rest.strip_prefix('s').unwrap_or(rest);
    let (base, digits) = match rest.split_at_checked(1) {
        Some((b, d)) => (b.to_ascii_lowercase(), d.replace('_', "")),
        None => return Value::from(text),
    };
    let unknown = digits.bytes().any(|b| matches!(b, b'x' | b'X' | b'z' | b'Z' | b'?'));
    match base.as_str() {
        "b" if unknown => Value::from(format!("0b{}", digits.to_ascii_lowercase())),
        "b" => Value::from(format!("0b{digits}")),
        "h" => Value::from(format!("0x{}", digits.to_ascii_lowercase())),
        "o" if !unknown => match u64::from_str_radix(&digits, 8) {
            Ok(v) => Value::from(format!("0x{v:x}")),
            Err(_) => Value::from(text),
        },
        "d" if !unknown => Value::from(digits),
        _ => Value::from(format!("0x{}", digits.to_ascii_lowercase())),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn s(v: Value) -> String {
        match v {
            Value::Str(t) => t.into_string(),
            other => format!("{other:?}"),
        }
    }

    #[test]
    fn decodes_verilog_literals() {
        assert_eq!(s(literal("2'h3")), "0x3");
        assert_eq!(s(literal("32'sh4")), "0x4");
        assert_eq!(s(literal("8'h1f")), "0x1f");
        assert_eq!(s(literal("4'b1010")), "0b1010");
        assert_eq!(s(literal("3'o7")), "0x7");
        assert_eq!(s(literal("32'd42")), "42");
        assert_eq!(s(literal("8'h1_f")), "0x1f", "underscores are separators");
        assert_eq!(s(literal("42")), "42", "a bare integer passes through");
    }

    #[test]
    fn keeps_unknown_bits_rather_than_losing_them() {
        assert_eq!(s(literal("4'b10x1")), "0b10x1");
        assert_eq!(s(literal("8'hzz")), "0xzz");
    }

    #[test]
    fn keyword_table_separates_two_and_four_state() {
        assert_eq!(keyword_facts("bit"), (Some(1), Some(2)));
        assert_eq!(keyword_facts("logic"), (Some(1), Some(4)));
        // The classic trap: `int` is 2-state, `integer` is 4-state.
        assert_eq!(keyword_facts("int"), (Some(32), Some(2)));
        assert_eq!(keyword_facts("integer"), (Some(32), Some(4)));
        assert_eq!(keyword_facts("real"), (Some(64), None));
        assert_eq!(keyword_facts("string"), (None, None));
    }

    #[test]
    fn parses_both_range_spellings() {
        assert_eq!(parse_colon_range("7:0"), Some([7, 0]));
        assert_eq!(parse_colon_range("0:7"), Some([0, 7]), "ascending survives");
        assert_eq!(parse_bracket_range("[3:0]"), Some([3, 0]));
        assert_eq!(parse_bracket_range("[0:3]"), Some([0, 3]));
        assert_eq!(parse_bracket_range("3:0"), None, "declRange always has brackets");
    }
}
