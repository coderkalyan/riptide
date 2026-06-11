//! The wgpu renderer: ports of `src/renderer/gpu/*.ts` with the WGSL shaders
//! reused (near-)verbatim from `shaders/`. Surface-agnostic by design — this
//! crate takes a `wgpu::Device`/`Queue`/`TextureView` and never creates a
//! surface, so every pipeline is headless-testable (render to texture) and the
//! same code runs on browser WebGPU for a future wasm target. Surface
//! acquisition/present lives in `src-tauri`.

pub mod capture;
pub mod colors;
pub mod device;
pub mod digital;
pub mod frame;
pub mod labels;
pub mod lines;
pub mod rect;
pub mod scene;
pub mod text;
pub mod timing;

/// WGSL sources (single source of truth for the Rust side; the copies under
/// `src/renderer/gpu/` only feed the still-buildable Electron entry and are
/// deleted at integration). `digital.wgsl` here carries the one semantic edit
/// of the migration: the `F_HATCH_COLOR` X/Z predicate flip (unit U6).
pub const DIGITAL_WGSL: &str = include_str!("../shaders/digital.wgsl");
pub const LABELS_WGSL: &str = include_str!("../shaders/labels.wgsl");
pub const LINES_WGSL: &str = include_str!("../shaders/lines.wgsl");
pub const RECT_WGSL: &str = include_str!("../shaders/rect.wgsl");
pub const TEXT_WGSL: &str = include_str!("../shaders/text.wgsl");
