//! The frozen cross-unit contract for the Tauri/wgpu migration.
//!
//! Every type that crosses a unit boundary (Rust crate ↔ crate, Rust ↔ JS over
//! Tauri IPC, CPU ↔ GPU buffer layout) lives here. Serde-only + bytemuck, no
//! other deps — wasm-clean by construction. The TS mirror is
//! `src/renderer/ipc/types.ts`; keep the two in lockstep.
//!
//! GPU-layout types (`gpu` module) are byte-for-byte ports of
//! `native/src/segments.zig` + `src/renderer/gpu/data.ts` and must stay in sync
//! with the WGSL structs in `crates/riptide-render/shaders/*.wgsl`.

pub mod doc;
pub mod geometry;
pub mod gpu;
pub mod hier;
pub mod ipc;
pub mod pack;
pub mod spec;
