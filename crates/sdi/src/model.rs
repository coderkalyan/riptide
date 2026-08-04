//! The SDI record types, mirroring `docs/sdi.schema.json` one-for-one.
//!
//! Struct field order **is** JSON key order, and it follows the schema's own
//! ordering so generated files diff cleanly. Every optional field is skipped when
//! empty, so a lean producer's output carries no `null`s.
//!
//! `Type` is one flat struct rather than fifteen enum variants. The schema is the
//! contract for which field combinations are legal per `kind`, and per-kind legality
//! is checked in [`crate::validate`]; encoding it as variants would mean fifteen
//! near-identical bodies repeating the eight common fields, for no reader benefit.
//! The types table is interned and tiny even on large designs, so nothing about this
//! choice is on a hot path.

use std::collections::BTreeMap;

use serde::de::{self, SeqAccess, Visitor};
use serde::ser::SerializeSeq;
use serde::{Deserialize, Deserializer, Serialize, Serializer};

use crate::enums::*;

/// Interned strings are the common case; `Box<str>` is two words instead of three
/// and never over-allocates, which matters at a few hundred thousand records.
pub type Text = Box<str>;

fn is_false(b: &bool) -> bool {
    !*b
}
#[allow(dead_code)]
fn is_zero(n: &u32) -> bool {
    *n == 0
}

// ---------------------------------------------------------------- span and bits

/// A source range, serialized positionally as `[file, line, col?, endLine?, endCol?]`.
///
/// 1-based lines and columns, `endCol` exclusive, `endLine` defaulting to `line`.
/// Trailing zeros are elided on write, so a whole-line span costs two elements.
#[derive(Clone, Copy, PartialEq, Eq, Debug, Default)]
pub struct Span {
    pub file: u32,
    pub line: u32,
    pub col: u32,
    pub end_line: u32,
    pub end_col: u32,
}

impl Span {
    pub fn line(file: u32, line: u32) -> Self {
        Self { file, line, ..Default::default() }
    }

    pub fn range(file: u32, line: u32, col: u32, end_line: u32, end_col: u32) -> Self {
        Self { file, line, col, end_line, end_col }
    }

    /// Elements actually written: never fewer than 2, never more than 5.
    fn len(&self) -> usize {
        if self.end_col != 0 {
            5
        } else if self.end_line != 0 {
            4
        } else if self.col != 0 {
            3
        } else {
            2
        }
    }
}

impl Serialize for Span {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        let n = self.len();
        let all = [self.file, self.line, self.col, self.end_line, self.end_col];
        let mut seq = s.serialize_seq(Some(n))?;
        for v in &all[..n] {
            seq.serialize_element(v)?;
        }
        seq.end()
    }
}

impl<'de> Deserialize<'de> for Span {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        struct V;
        impl<'de> Visitor<'de> for V {
            type Value = Span;
            fn expecting(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
                f.write_str("a span array [file, line, col?, endLine?, endCol?]")
            }
            fn visit_seq<A: SeqAccess<'de>>(self, mut a: A) -> Result<Span, A::Error> {
                let file = a.next_element()?.ok_or_else(|| de::Error::invalid_length(0, &self))?;
                let line = a.next_element()?.ok_or_else(|| de::Error::invalid_length(1, &self))?;
                let col = a.next_element()?.unwrap_or(0);
                let end_line = a.next_element()?.unwrap_or(0);
                let end_col = a.next_element()?.unwrap_or(0);
                while a.next_element::<u32>()?.is_some() {}
                Ok(Span { file, line, col, end_line, end_col })
            }
        }
        d.deserialize_seq(V)
    }
}

/// A bit slice, serialized positionally as `[lsb, width]`, in the flattened bit
/// order the trace stores. Zero width is legal: a void- or unit-typed signal
/// carries no bits and still participates in dataflow.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct Bits {
    pub lsb: u32,
    pub width: u32,
}

impl Bits {
    pub const fn new(lsb: u32, width: u32) -> Self {
        Self { lsb, width }
    }
    /// Whether two slices touch. A zero-width slice constrains nothing.
    pub const fn overlaps(self, other: Self) -> bool {
        if self.width == 0 || other.width == 0 {
            return true;
        }
        self.lsb < other.lsb + other.width && other.lsb < self.lsb + self.width
    }
}

impl Serialize for Bits {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        let mut seq = s.serialize_seq(Some(2))?;
        seq.serialize_element(&self.lsb)?;
        seq.serialize_element(&self.width)?;
        seq.end()
    }
}

impl<'de> Deserialize<'de> for Bits {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        let [lsb, width] = <[u32; 2]>::deserialize(d)?;
        Ok(Self { lsb, width })
    }
}

/// A constant, interpreted against the type it belongs to: a bit literal string
/// (`0x1f`, `0b10x1`, `-3`), a JSON number for reals, or a bare string for string
/// types. Never a JSON number for a wide bit value — that does not survive a double.
#[derive(Clone, PartialEq, Debug, Serialize, Deserialize)]
#[serde(untagged)]
pub enum Value {
    Str(Text),
    Num(f64),
    Bool(bool),
}

impl From<&str> for Value {
    fn from(s: &str) -> Self {
        Value::Str(s.into())
    }
}
impl From<String> for Value {
    fn from(s: String) -> Self {
        Value::Str(s.into_boxed_str())
    }
}
impl From<u64> for Value {
    fn from(n: u64) -> Self {
        Value::Str(n.to_string().into_boxed_str())
    }
}

// ------------------------------------------------------------------------ root

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Sdi {
    pub version: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub generator: Option<Generator>,
    #[serde(default, skip_serializing_if = "Fidelity::is_empty")]
    pub fidelity: Fidelity,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub trace: Option<TraceBinding>,
    pub design: Design,
    pub files: Vec<SourceFile>,
    pub types: Vec<Type>,
    pub units: Vec<Unit>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub warnings: Vec<Text>,
}

/// The one version this crate reads and writes.
pub const VERSION: u32 = 1;

impl Sdi {
    pub fn new(design: Design) -> Self {
        Self {
            version: VERSION,
            generator: None,
            fidelity: Fidelity::default(),
            trace: None,
            design,
            files: Vec::new(),
            types: Vec::new(),
            units: Vec::new(),
            warnings: Vec::new(),
        }
    }

    pub fn unit(&self, idx: u32) -> Option<&Unit> {
        self.units.get(idx as usize)
    }
    pub fn ty(&self, idx: u32) -> Option<&Type> {
        self.types.get(idx as usize)
    }

    /// Flattened bit width of a type, following an alias chain.
    pub fn width_of(&self, idx: u32) -> Option<u32> {
        let mut cur = idx;
        for _ in 0..32 {
            let t = self.ty(cur)?;
            if let Some(w) = t.width {
                return Some(w);
            }
            match (t.kind, t.target) {
                (TypeKind::Alias, Some(next)) => cur = next,
                _ => return None,
            }
        }
        None
    }
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Generator {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool: Option<Text>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_version: Option<Text>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub command: Option<Text>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub created_at: Option<Text>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_root: Option<Text>,
}

/// Positive claims, one per axis. Every field is elidable and absence means "the
/// producer said nothing", which a consumer must read as the weakest claim.
#[derive(Clone, Copy, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Fidelity {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tree: Option<TreeFidelity>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub types: Option<TypeFidelity>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub drivers: Option<Coverage>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bits: Option<BitsFidelity>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub coi: Option<Coverage>,
}

impl Fidelity {
    pub fn is_empty(&self) -> bool {
        self.tree.is_none()
            && self.types.is_none()
            && self.drivers.is_none()
            && self.bits.is_none()
            && self.coi.is_none()
    }
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TraceBinding {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub format: Option<Text>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub files: Vec<Text>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub separator: Option<Text>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub root_prefix: Option<Text>,
    #[serde(default, skip_serializing_if = "is_false")]
    pub range_in_name: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub case_sensitive: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub escape_style: Option<EscapeStyle>,
}

impl TraceBinding {
    pub fn separator(&self) -> &str {
        self.separator.as_deref().unwrap_or(".")
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Design {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<Text>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub language: Option<Language>,
    pub roots: Vec<Root>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Root {
    pub name: Text,
    pub unit: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub decl: Option<Span>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceFile {
    pub path: Text,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub real_path: Option<Text>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub language: Option<Language>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub blake3: Option<Text>,
}

// ------------------------------------------------------------------------ types

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Type {
    pub kind: TypeKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<Text>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub spelling: Option<Text>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub width: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub states: Option<u8>,
    #[serde(default, skip_serializing_if = "is_false")]
    pub signed: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub keyword: Option<Text>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub range: Option<[i64; 2]>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub base: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub elem: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub shape: Option<ArrayShape>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub key_type: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target: Option<u32>,
    #[serde(default, skip_serializing_if = "is_false")]
    pub packed: bool,
    #[serde(default, skip_serializing_if = "is_false")]
    pub tagged: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub unit: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub modport: Option<Text>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub note: Option<Text>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub decl: Option<Span>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub comment: Option<Text>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub values: Vec<EnumValue>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub members: Vec<Member>,
}

impl Type {
    pub fn of(kind: TypeKind) -> Self {
        Self {
            kind,
            name: None,
            spelling: None,
            width: None,
            states: None,
            signed: false,
            keyword: None,
            range: None,
            base: None,
            elem: None,
            shape: None,
            key_type: None,
            target: None,
            packed: false,
            tagged: false,
            unit: None,
            modport: None,
            note: None,
            decl: None,
            comment: None,
            values: Vec::new(),
            members: Vec::new(),
        }
    }

    pub fn bits(keyword: &str, width: u32, states: u8) -> Self {
        let mut t = Self::of(TypeKind::Bits);
        t.keyword = Some(keyword.into());
        t.width = Some(width);
        t.states = Some(states);
        t
    }

    pub fn display_name(&self) -> &str {
        self.spelling
            .as_deref()
            .or(self.name.as_deref())
            .or(self.keyword.as_deref())
            .unwrap_or_else(|| self.kind.as_str())
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EnumValue {
    pub name: Text,
    pub value: Value,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub decl: Option<Span>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub comment: Option<Text>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Member {
    pub name: Text,
    #[serde(rename = "type")]
    pub ty: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub lsb: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub decl: Option<Span>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub comment: Option<Text>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub value: Option<Value>,
}

// ------------------------------------------------------------------------ units

pub type Attrs = BTreeMap<Text, Text>;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Unit {
    pub kind: UnitKind,
    pub name: Text,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub orig_name: Option<Text>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub decl: Option<Span>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub body: Option<Span>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub language: Option<Language>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub comment: Option<Text>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub attrs: Attrs,
    #[serde(default, skip_serializing_if = "Fidelity::is_empty")]
    pub fidelity: Fidelity,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub params: Vec<Param>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub ports: Vec<u32>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub vars: Vec<Var>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub instances: Vec<Instance>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub processes: Vec<Process>,
}

impl Unit {
    pub fn new(kind: UnitKind, name: impl Into<Text>) -> Self {
        Self {
            kind,
            name: name.into(),
            orig_name: None,
            decl: None,
            body: None,
            language: None,
            comment: None,
            attrs: Attrs::new(),
            fidelity: Fidelity::default(),
            params: Vec::new(),
            ports: Vec::new(),
            vars: Vec::new(),
            instances: Vec::new(),
            processes: Vec::new(),
        }
    }

    /// Declaration ordinal of a port, given its index in `vars`.
    pub fn port_ordinal(&self, var: u32) -> Option<u32> {
        self.ports.iter().position(|&p| p == var).map(|i| i as u32)
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Param {
    pub name: Text,
    #[serde(rename = "type", default, skip_serializing_if = "Option::is_none")]
    pub ty: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub value: Option<Value>,
    #[serde(default, skip_serializing_if = "is_false")]
    pub local: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub decl: Option<Span>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub comment: Option<Text>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Var {
    pub name: Text,
    #[serde(rename = "type")]
    pub ty: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kind: Option<VarKind>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub net_type: Option<Text>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub direction: Option<Direction>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub decl: Option<Span>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub value: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub comment: Option<Text>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub attrs: Attrs,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hints: Option<Hints>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub trace_name: Option<Text>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub trace_signals: Vec<TraceSignal>,
    #[serde(default, skip_serializing_if = "is_false")]
    pub trace_omitted: bool,
}

impl Var {
    pub fn new(name: impl Into<Text>, ty: u32) -> Self {
        Self {
            name: name.into(),
            ty,
            kind: None,
            net_type: None,
            direction: None,
            decl: None,
            value: None,
            comment: None,
            attrs: Attrs::new(),
            hints: None,
            trace_name: None,
            trace_signals: Vec::new(),
            trace_omitted: false,
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TraceSignal {
    pub path: Text,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bits: Option<Bits>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub member: Option<Text>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Hints {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub role: Option<HintRole>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub polarity: Option<Polarity>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub radix: Option<Radix>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub group: Option<Text>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hide: Option<bool>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Instance {
    pub name: Text,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kind: Option<InstanceKind>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub unit: Option<u32>,
    #[serde(default, skip_serializing_if = "is_false")]
    pub black_box: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub decl: Option<Span>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub array: Option<[i64; 2]>,
    #[serde(default, skip_serializing_if = "is_false")]
    pub inlined: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub trace_prefix: Option<Text>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub params: Vec<ParamOverride>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub conns: Vec<Conn>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub comment: Option<Text>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub attrs: Attrs,
}

impl Instance {
    pub fn new(name: impl Into<Text>, kind: InstanceKind) -> Self {
        Self {
            name: name.into(),
            kind: Some(kind),
            unit: None,
            black_box: false,
            decl: None,
            array: None,
            inlined: false,
            trace_prefix: None,
            params: Vec::new(),
            conns: Vec::new(),
            comment: None,
            attrs: Attrs::new(),
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ParamOverride {
    pub name: Text,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub value: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub loc: Option<Span>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text: Option<Text>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Conn {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub port: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<Text>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bits: Option<Bits>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub loc: Option<Span>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub reads: Vec<Ref>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub writes: Vec<Ref>,
    #[serde(default, skip_serializing_if = "is_false")]
    pub positional: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text: Option<Text>,
}

// -------------------------------------------------------------------- processes

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Process {
    pub kind: ProcessKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub loc: Option<Span>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<Text>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub sense: Vec<Sense>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub assigns: Vec<Assign>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub reads: Vec<Ref>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub comment: Option<Text>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub attrs: Attrs,
}

impl Process {
    pub fn new(kind: ProcessKind) -> Self {
        Self {
            kind,
            loc: None,
            label: None,
            sense: Vec::new(),
            assigns: Vec::new(),
            reads: Vec::new(),
            comment: None,
            attrs: Attrs::new(),
        }
    }

    /// Sequential when the construct says so, or when any sensitivity entry is an
    /// edge. This single bit separates a same-cycle cone from a whole-design one.
    pub fn is_sequential(&self) -> bool {
        self.kind.is_sequential()
            || self
                .sense
                .iter()
                .any(|s| s.edge.is_some_and(Edge::is_edge))
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Sense {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub edge: Option<Edge>,
    #[serde(rename = "ref")]
    pub reference: Ref,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub role: Option<SenseRole>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Assign {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub loc: Option<Span>,
    pub targets: Vec<Ref>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub sources: Vec<Ref>,
    #[serde(default, skip_serializing_if = "is_false")]
    pub non_blocking: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub delay: Option<Text>,
    #[serde(default, skip_serializing_if = "is_false")]
    pub guarded: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text: Option<Text>,
}

// -------------------------------------------------------------------- references

/// What a [`Ref`] points at. Exactly one form is written, which is why `Ref` has a
/// hand-written serializer instead of a `#[serde(flatten)]` enum: flatten would
/// buffer every reference through an intermediate value, and references are the most
/// numerous records in the file.
#[derive(Clone, PartialEq, Eq, Debug)]
pub enum Target {
    /// A variable of the enclosing unit (after `up` hops).
    Var(u32),
    /// A port of a child instance, addressed from the parent.
    Port { inst: u32, port: u32 },
    /// A dotted path the producer could not resolve to a local index.
    Xmr(Text),
}

#[derive(Clone, PartialEq, Eq, Debug)]
pub struct Ref {
    pub target: Target,
    /// Lexical scope hops out to the owner. Only valid across block-like scopes.
    pub up: u32,
    pub bits: Option<Bits>,
    pub role: Option<RefRole>,
    pub dynamic: bool,
    pub select: Option<Text>,
    pub loc: Option<Span>,
}

impl Ref {
    pub fn var(idx: u32) -> Self {
        Self::to(Target::Var(idx))
    }
    pub fn port(inst: u32, port: u32) -> Self {
        Self::to(Target::Port { inst, port })
    }
    pub fn xmr(path: impl Into<Text>) -> Self {
        Self::to(Target::Xmr(path.into()))
    }
    pub fn to(target: Target) -> Self {
        Self { target, up: 0, bits: None, role: None, dynamic: false, select: None, loc: None }
    }
    pub fn with_up(mut self, up: u32) -> Self {
        self.up = up;
        self
    }
    pub fn with_bits(mut self, bits: Option<Bits>) -> Self {
        self.bits = bits;
        self
    }
    pub fn with_role(mut self, role: Option<RefRole>) -> Self {
        self.role = role;
        self
    }
    pub fn role_or_data(&self) -> RefRole {
        self.role.unwrap_or(RefRole::Data)
    }
}

impl Serialize for Ref {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        use serde::ser::SerializeMap;
        // Count first: serialize_map with a known length lets serde_json skip a
        // reallocation, and references dominate the record count.
        let extra = usize::from(self.up != 0)
            + usize::from(self.bits.is_some())
            + usize::from(self.role.is_some())
            + usize::from(self.dynamic)
            + usize::from(self.select.is_some())
            + usize::from(self.loc.is_some());
        let base = match &self.target {
            Target::Port { .. } => 2,
            _ => 1,
        };
        let mut m = s.serialize_map(Some(base + extra))?;
        match &self.target {
            Target::Var(v) => m.serialize_entry("var", v)?,
            Target::Port { inst, port } => {
                m.serialize_entry("inst", inst)?;
                m.serialize_entry("port", port)?;
            }
            Target::Xmr(path) => m.serialize_entry("xmr", path)?,
        }
        if self.up != 0 {
            m.serialize_entry("up", &self.up)?;
        }
        if let Some(bits) = &self.bits {
            m.serialize_entry("bits", bits)?;
        }
        if let Some(role) = &self.role {
            m.serialize_entry("role", role)?;
        }
        if self.dynamic {
            m.serialize_entry("dynamic", &true)?;
        }
        if let Some(select) = &self.select {
            m.serialize_entry("select", select)?;
        }
        if let Some(loc) = &self.loc {
            m.serialize_entry("loc", loc)?;
        }
        m.end()
    }
}

impl<'de> Deserialize<'de> for Ref {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct Raw {
            var: Option<u32>,
            inst: Option<u32>,
            port: Option<u32>,
            xmr: Option<Text>,
            #[serde(default)]
            up: u32,
            bits: Option<Bits>,
            role: Option<RefRole>,
            #[serde(default)]
            dynamic: bool,
            select: Option<Text>,
            loc: Option<Span>,
        }
        let r = Raw::deserialize(d)?;
        let target = match (r.var, r.inst, r.port, r.xmr) {
            (Some(v), None, None, None) => Target::Var(v),
            (None, Some(inst), Some(port), None) => Target::Port { inst, port },
            (None, None, None, Some(path)) => Target::Xmr(path),
            _ => {
                return Err(de::Error::custom(
                    "a ref must carry exactly one of `var`, `inst`+`port`, or `xmr`",
                ));
            }
        };
        Ok(Ref {
            target,
            up: r.up,
            bits: r.bits,
            role: r.role,
            dynamic: r.dynamic,
            select: r.select,
            loc: r.loc,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn json(v: &impl Serialize) -> String {
        serde_json::to_string(v).unwrap()
    }

    #[test]
    fn spans_elide_trailing_zeros() {
        assert_eq!(json(&Span::line(0, 91)), "[0,91]");
        assert_eq!(json(&Span::range(0, 91, 3, 0, 0)), "[0,91,3]");
        assert_eq!(json(&Span::range(2, 91, 3, 94, 0)), "[2,91,3,94]");
        assert_eq!(json(&Span::range(2, 91, 3, 91, 31)), "[2,91,3,91,31]");
    }

    #[test]
    fn spans_round_trip_from_short_arrays() {
        let s: Span = serde_json::from_str("[1,42]").unwrap();
        assert_eq!(s, Span::line(1, 42));
        let s: Span = serde_json::from_str("[1,42,7,42,9]").unwrap();
        assert_eq!(s.end_col, 9);
        // Over-long spans are tolerated rather than rejected, per the loader rules.
        let s: Span = serde_json::from_str("[1,42,7,42,9,99]").unwrap();
        assert_eq!(s.end_col, 9);
    }

    #[test]
    fn zero_width_slices_constrain_nothing() {
        let void = Bits::new(0, 0);
        assert!(void.overlaps(Bits::new(8, 4)));
        assert!(Bits::new(8, 4).overlaps(void));
        assert!(Bits::new(0, 4).overlaps(Bits::new(3, 4)));
        assert!(!Bits::new(0, 4).overlaps(Bits::new(4, 4)));
        assert_eq!(json(&void), "[0,0]");
    }

    #[test]
    fn refs_write_exactly_one_target_form() {
        assert_eq!(json(&Ref::var(7)), r#"{"var":7}"#);
        assert_eq!(
            json(&Ref::var(7).with_up(1).with_bits(Some(Bits::new(8, 8)))),
            r#"{"var":7,"up":1,"bits":[8,8]}"#
        );
        assert_eq!(json(&Ref::port(2, 5)), r#"{"inst":2,"port":5}"#);
        assert_eq!(json(&Ref::xmr("top.u.sig")), r#"{"xmr":"top.u.sig"}"#);
    }

    #[test]
    fn refs_reject_ambiguous_targets() {
        let err = serde_json::from_str::<Ref>(r#"{"var":1,"xmr":"a.b"}"#).unwrap_err();
        assert!(err.to_string().contains("exactly one"), "{err}");
        assert!(serde_json::from_str::<Ref>(r#"{"inst":1}"#).is_err());
    }

    #[test]
    fn empty_optionals_are_not_written() {
        let u = Unit::new(UnitKind::Module, "gate");
        assert_eq!(json(&u), r#"{"kind":"module","name":"gate"}"#);
    }

    #[test]
    fn a_process_is_sequential_if_any_sense_is_an_edge() {
        let mut p = Process::new(ProcessKind::AlwaysComb);
        assert!(!p.is_sequential());
        p.sense.push(Sense {
            edge: Some(Edge::Pos),
            reference: Ref::var(0),
            role: Some(SenseRole::Clock),
        });
        assert!(p.is_sequential());
        assert!(Process::new(ProcessKind::AlwaysFf).is_sequential());
    }
}
