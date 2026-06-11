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

use riptide_contract::hier::HierarchyDto;
use tide::{
    BucketQuery, EdgeKind, SampleRef, SignalId, SignalQuery, Time, TimeRange, Timescale, Waves,
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
    /// STUB — implemented by unit U10.
    pub fn hierarchy_dto(&self) -> HierarchyDto {
        todo!("U10: map tide::Hierarchy scopes/vars to HierarchyDto")
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
