//! The per-signal pack cache — the Rust port of `main.zig`'s `pack_cache`.
//!
//! Keyed by [`PackKey`] (everything that affects a signal's packed form
//! EXCEPT its row), so an add/remove/reorder/radix-change repacks only the
//! changed signal; unchanged rows replay their cached [`PackedSignal`] via
//! the scene assembly (row OR-in, no tide query, no label format).
//!
//! Unlike the original (which packed the full trace), packs are now windowed
//! (`[q_start, q_end]`), so an entry is only reusable while the window is
//! unchanged — each entry remembers its window, and [`PackCache::retain_window`]
//! evicts entries from any other window at the top of every `Packer::pack`
//! call (a pan/zoom that moves the query window invalidates everything; an
//! add/remove/reorder/radix-change keeps the window and hits). This also
//! bounds growth: the map only ever holds current-window entries.

use std::collections::HashMap;

use riptide_contract::pack::PackKey;

use super::PackedSignal;

struct Entry {
    q_start: u64,
    q_end: u64,
    ps: PackedSignal,
}

/// `PackKey → (window, packed signal)`. One entry per key: a key re-packed
/// over a new window replaces its stale entry.
#[derive(Default)]
pub(super) struct PackCache {
    map: HashMap<PackKey, Entry>,
}

impl PackCache {
    /// The cached pack for `key` over exactly `[q_start, q_end]`, if any.
    pub(super) fn get(&self, key: &PackKey, q_start: u64, q_end: u64) -> Option<&PackedSignal> {
        self.map
            .get(key)
            .filter(|e| e.q_start == q_start && e.q_end == q_end)
            .map(|e| &e.ps)
    }

    pub(super) fn contains(&self, key: &PackKey, q_start: u64, q_end: u64) -> bool {
        self.get(key, q_start, q_end).is_some()
    }

    pub(super) fn insert(&mut self, key: PackKey, q_start: u64, q_end: u64, ps: PackedSignal) {
        self.map.insert(key, Entry { q_start, q_end, ps });
    }

    /// Evicts every entry whose window differs from `[q_start, q_end]`.
    pub(super) fn retain_window(&mut self, q_start: u64, q_end: u64) {
        self.map
            .retain(|_, e| e.q_start == q_start && e.q_end == q_end);
    }

    /// Drops everything (trace swap — handles invalidate).
    pub(super) fn clear(&mut self) {
        self.map.clear();
    }
}
