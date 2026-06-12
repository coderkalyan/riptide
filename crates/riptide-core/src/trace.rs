//! Thin adapter over `tide::Waves` — the seam every other module queries
//! through. Fully implemented in the seed (it is pure delegation) so packing /
//! clock / bucket units need no sibling code.
//!
//! Plane convention note (differs from the Zig tide!): tide.rs is plane-major
//! with X = (p0=1, p1=1) and Z = (p0=0, p1=1); the old Zig db had x = (lsb=0,
//! msb=1), z = (lsb=1, msb=1). (p0, p1) maps to the GPU pools' (x0, x1) — for
//! 0/1 the conventions agree, for unknown bits `x0_zig = p0 XOR p1`. The WGSL
//! side is adjusted once (`F_HATCH_COLOR` in digital.wgsl, unit U6); all Rust
//! code uses the tide.rs convention.

use std::path::{Path, PathBuf};

use riptide_contract::hier::{HierarchyDto, NodeDto, TimescaleDto};
use tide::{
    BucketQuery, EdgeKind, Hierarchy, SampleRef, ScopeKind, ScopeRef, SignalId, SignalQuery, Time,
    TimeRange, Timescale, VarKind, Waves,
};

use crate::Error;

pub struct TraceDb {
    waves: Waves,
    path: PathBuf,
    end_ticks: u64,
}

impl TraceDb {
    /// Opens a VCD (header + block index; signal data loads lazily per query).
    pub fn open(path: impl AsRef<Path>) -> Result<Self, Error> {
        let path = path.as_ref().to_path_buf();
        let waves = Waves::open_vcd(&path)?;
        let end_ticks = waves.time_range().map(|(_, last)| last).unwrap_or(0);
        Ok(Self { waves, path, end_ticks })
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    /// The trace's last event time (the old native `end_t` / `endTicks`).
    pub fn end_ticks(&self) -> u64 {
        self.end_ticks
    }

    pub fn timescale(&self) -> Option<Timescale> {
        self.waves.timescale()
    }

    /// Resolves a hierarchical dot path to a signal id.
    pub fn find(&self, path: &str) -> Option<SignalId> {
        self.waves.find(path).map(|v| v.signal)
    }

    /// Parses the DTO-side decimal handle back to a signal id.
    pub fn handle(handle: &str) -> Result<SignalId, Error> {
        handle
            .parse::<u64>()
            .map(SignalId)
            .map_err(|_| Error::UnknownHandle(handle.to_string()))
    }

    /// Covering-set range query (last sample at-or-before start + all samples
    /// in (start, end]), batched.
    pub fn query(
        &mut self,
        ids: &[SignalId],
        range: TimeRange,
    ) -> Result<Vec<Option<SignalQuery<'_>>>, Error> {
        Ok(self.waves.query(ids, range)?)
    }

    /// Exact downsampled query: fixed-width buckets of `period` ticks anchored
    /// at `range.start`.
    pub fn query_buckets(
        &mut self,
        ids: &[SignalId],
        range: TimeRange,
        period: Time,
    ) -> Result<Vec<Option<BucketQuery>>, Error> {
        Ok(self.waves.query_buckets(ids, range, period)?)
    }

    /// Batched cursor read (the old `getValueAt`).
    pub fn value_at(
        &mut self,
        ids: &[SignalId],
        t: Time,
    ) -> Result<Vec<Option<SampleRef<'_>>>, Error> {
        Ok(self.waves.value_at(ids, t)?)
    }

    /// Up to `count` samples at/after `start` — the old `getEdges` prefix read
    /// used by clock-grid / reset-band detection (tide `query_next`).
    pub fn edges(
        &mut self,
        id: SignalId,
        start: Time,
        count: u32,
    ) -> Result<Option<SignalQuery<'_>>, Error> {
        Ok(self.waves.query_next(id, start, count)?)
    }

    pub fn next_change(&mut self, id: SignalId, t: Time) -> Result<Option<Time>, Error> {
        Ok(self.waves.next_change(id, t)?)
    }

    pub fn prev_change(&mut self, id: SignalId, t: Time) -> Result<Option<Time>, Error> {
        Ok(self.waves.prev_change(id, t)?)
    }

    pub fn next_edge(
        &mut self,
        id: SignalId,
        t: Time,
        edge: EdgeKind,
    ) -> Result<Option<Time>, Error> {
        Ok(self.waves.next_edge(id, t, edge)?)
    }

    pub fn diagnostics(&self) -> Vec<String> {
        self.waves.diagnostics().map(|d| format!("{d:?}")).collect()
    }

    /// The full hierarchy as the JS-facing DTO (mirrors the Zig `getHierarchy`
    /// node/string vocabulary — see `hier.rs` in the contract crate).
    ///
    /// Node ids are assigned in DFS pre-order exactly like the Zig builder
    /// flattened (`mock_db.zig walkInto`): each scope gets the next id when
    /// entered, then its vars (file order), then its child scopes (file
    /// order) — so a scope's `children` list is var ids followed by child
    /// scope ids. Vars declared in the synthetic root are dropped, matching
    /// the Zig walk (it only descended into top-level scopes).
    pub fn hierarchy_dto(&self) -> HierarchyDto {
        let h = self.waves.hierarchy();
        let mut nodes = Vec::with_capacity(h.scope_count() - 1 + h.var_count());
        let mut root_ids = Vec::new();
        for scope in h.child_scopes(ScopeRef::ROOT) {
            root_ids.push(append_scope(h, scope, None, &mut nodes));
        }
        HierarchyDto {
            root_ids,
            nodes,
            timescale: self
                .timescale()
                .map(timescale_dto)
                // The old Zig parser always carried a $timescale; a VCD
                // without one falls back to the VCD-conventional 1 ns.
                .unwrap_or(TimescaleDto { value: 1, unit: "ns".to_string() }),
            end_ticks: self.end_ticks as f64,
        }
    }

    /// Direct access for modules that need tide APIs not wrapped here. Prefer
    /// the wrappers; this is the escape hatch.
    pub fn waves_mut(&mut self) -> &mut Waves {
        &mut self.waves
    }

    pub fn waves(&self) -> &Waves {
        &self.waves
    }
}

/// Maps a tide timescale to the DTO's `$timescale`-style decomposition
/// (mantissa 1/10/100 + unit string), mirroring the Zig `mapTimescale`.
pub(crate) fn timescale_dto(ts: Timescale) -> TimescaleDto {
    let unit = match ts.unit_exponent() {
        0 => "s",
        -3 => "ms",
        -6 => "us",
        -9 => "ns",
        -12 => "ps",
        _ => "fs",
    };
    TimescaleDto { value: ts.mantissa(), unit: unit.to_string() }
}

/// Appends `scope` (and its subtree) to `nodes` in Zig-flattening order and
/// returns the scope's node id.
fn append_scope(
    h: &Hierarchy,
    scope: ScopeRef,
    parent: Option<u32>,
    nodes: &mut Vec<NodeDto>,
) -> u32 {
    let s = h.scope(scope);
    let id = nodes.len() as u32;
    nodes.push(NodeDto::Scope {
        id,
        parent,
        name: s.name.to_string(),
        scope_type: scope_type_str(s.kind).to_string(),
        children: Vec::new(),
    });

    let mut children = Vec::new();
    for var in h.vars(scope) {
        let v = h.var(var);
        let var_id = nodes.len() as u32;
        nodes.push(NodeDto::Signal {
            id: var_id,
            parent: Some(id),
            name: v.name.to_string(),
            var_type: var_type_str(v.kind).to_string(),
            // VCD carries no port direction; the Zig DTO always said implicit.
            direction: "implicit".to_string(),
            bit_width: v.width,
            handle: v.signal.0.to_string(),
        });
        children.push(var_id);
    }
    for child in h.child_scopes(scope) {
        children.push(append_scope(h, child, Some(id), nodes));
    }

    let NodeDto::Scope { children: slot, .. } = &mut nodes[id as usize] else {
        unreachable!("node {id} was pushed as a scope above");
    };
    *slot = children;
    id
}

/// The `hier/types.ts ScopeType` string for a tide scope kind (same
/// vocabulary the Zig `scopeTypeStr` emitted, plus the VHDL kinds tide.rs
/// knows about).
fn scope_type_str(kind: ScopeKind) -> &'static str {
    match kind {
        // The synthetic root is never emitted as a node (the walk starts at
        // its children); map it like a plain container if it ever leaks.
        ScopeKind::Root | ScopeKind::Module => "module",
        ScopeKind::Task => "task",
        ScopeKind::Function => "function",
        ScopeKind::Begin => "begin",
        ScopeKind::Fork => "fork",
        ScopeKind::Generate => "generate",
        ScopeKind::Interface => "interface",
        ScopeKind::Package => "package",
        ScopeKind::Program => "program",
        ScopeKind::Class => "class",
        ScopeKind::Struct => "struct",
        ScopeKind::Union => "union",
        ScopeKind::Architecture => "vhdl_architecture",
        ScopeKind::Process => "vhdl_process",
        ScopeKind::Block => "vhdl_block",
        ScopeKind::Record => "vhdl_record",
    }
}

/// The `hier/types.ts VarType` string — byte-for-byte the Zig `mapVarType`
/// collapse: reg-like kinds are "vcd_reg", everything else "vcd_wire".
fn var_type_str(kind: VarKind) -> &'static str {
    match kind {
        VarKind::Reg | VarKind::Integer | VarKind::Time | VarKind::TriReg => "vcd_reg",
        _ => "vcd_wire",
    }
}
