//! Offscreen render → PNG readback (replaces `wave/capture.ts` + the
//! renderer-side save-canvas path; the `save_canvas` Tauri command calls
//! this).
//!
//! OWNED BY UNIT U12.

#[derive(Debug, thiserror::Error)]
pub enum CaptureError {
    #[error("buffer map failed: {0}")]
    Map(String),
    #[error("png encode failed: {0}")]
    Encode(String),
}

/// Renders one frame at `width`×`height` device px into an offscreen texture
/// via `draw`, reads it back, and returns encoded PNG bytes.
pub fn capture_png(
    _gpu: &crate::device::Gpu,
    _width: u32,
    _height: u32,
    _draw: &mut dyn FnMut(&wgpu::TextureView),
) -> Result<Vec<u8>, CaptureError> {
    todo!("U12")
}
