//! Hierarchy DTO — mirrors `src/renderer/native.ts RawHierarchy`/`RawNode`
//! exactly (field names and string enums), so the JS `getHierarchy` marshaller
//! and `SignalTree`/`hierarchy.ts` keep working unchanged. The scope/var type
//! strings use the same vocabulary the Zig `hier.zig` emitted (see
//! `src/renderer/hier/types.ts` `ScopeType`/`VarType`/`Direction`).

use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TimescaleDto {
    pub value: u32,
    /// "s" | "ms" | "us" | "ns" | "ps" | "fs"
    pub unit: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum NodeDto {
    #[serde(rename_all = "camelCase")]
    Scope {
        id: u32,
        parent: Option<u32>,
        name: String,
        scope_type: String,
        children: Vec<u32>,
    },
    #[serde(rename_all = "camelCase")]
    Signal {
        id: u32,
        parent: Option<u32>,
        name: String,
        var_type: String,
        direction: String,
        bit_width: u32,
        /// Trace signal id as a decimal string (tide `SignalId`).
        handle: String,
    },
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HierarchyDto {
    pub root_ids: Vec<u32>,
    pub nodes: Vec<NodeDto>,
    pub timescale: TimescaleDto,
    /// f64 so the full u64 tick range survives JSON (exact to 2^53).
    pub end_ticks: f64,
}
