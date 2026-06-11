//! The wasm-clean engine: trace access (tide), signal packing, value/label
//! formatting, viewport + input control, frame-geometry building. No wgpu, no
//! tauri, no filesystem beyond what `tide` does internally.
//!
//! Unit ownership (see MIGRATION.md): seed froze the public signatures here;
//! each module's body belongs to exactly one work unit.

pub mod clock;
pub mod engine;
pub mod format;
pub mod geometry;
pub mod input;
pub mod pack;
pub mod trace;
pub mod viewport;

pub use trace::TraceDb;

/// Engine-level errors.
#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error(transparent)]
    Tide(#[from] tide::Error),
    #[error("no trace loaded")]
    NoTrace,
    #[error("unknown signal handle: {0}")]
    UnknownHandle(String),
}
