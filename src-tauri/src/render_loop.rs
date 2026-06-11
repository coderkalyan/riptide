//! The native render loop: vsync-paced present with a dirty-flag scheme (the
//! old rAF `needsRender`), driving `Engine::frame()` → repack/geometry →
//! `riptide_render::frame::render_frame`.
//!
//! OWNED BY UNIT U1 (pacing/threading skeleton, proven with a test pipeline);
//! wired to the real engine + batches at INTEGRATION (U15).
