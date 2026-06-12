//! Offscreen render → PNG readback (replaces `wave/capture.ts` + the
//! renderer-side save-canvas path; the `save_canvas` Tauri command calls
//! this).
//!
//! OWNED BY UNIT U12.

use crate::device::Gpu;

#[derive(Debug, thiserror::Error)]
pub enum CaptureError {
    #[error("unsupported capture texture format {0:?} (need a 4-byte/pixel color format)")]
    Format(wgpu::TextureFormat),
    #[error("buffer map failed: {0}")]
    Map(String),
    #[error("png encode failed: {0}")]
    Encode(String),
}

/// Renders one frame at `width`×`height` device px into an offscreen texture
/// via `draw`, reads it back, and returns encoded PNG bytes.
///
/// The texture uses `gpu.format` so the pipelines the closure draws with
/// match their build-time target; BGRA targets are swizzled to RGBA before
/// encoding.
pub fn capture_png(
    gpu: &Gpu,
    width: u32,
    height: u32,
    draw: &mut dyn FnMut(&wgpu::TextureView),
) -> Result<Vec<u8>, CaptureError> {
    const BPP: u32 = 4;
    let bgra = match gpu.format {
        wgpu::TextureFormat::Rgba8Unorm | wgpu::TextureFormat::Rgba8UnormSrgb => false,
        wgpu::TextureFormat::Bgra8Unorm | wgpu::TextureFormat::Bgra8UnormSrgb => true,
        f => return Err(CaptureError::Format(f)),
    };

    let extent = wgpu::Extent3d { width, height, depth_or_array_layers: 1 };
    let texture = gpu.device.create_texture(&wgpu::TextureDescriptor {
        label: Some("capture-target"),
        size: extent,
        mip_level_count: 1,
        sample_count: 1,
        dimension: wgpu::TextureDimension::D2,
        format: gpu.format,
        usage: wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::COPY_SRC,
        view_formats: &[],
    });
    let view = texture.create_view(&wgpu::TextureViewDescriptor::default());
    draw(&view);

    // copy_texture_to_buffer requires bytes_per_row aligned to 256; copy with
    // the padded pitch, then strip the padding per row after mapping.
    let unpadded_bpr = width * BPP;
    let padded_bpr = unpadded_bpr.next_multiple_of(wgpu::COPY_BYTES_PER_ROW_ALIGNMENT);
    let readback = gpu.device.create_buffer(&wgpu::BufferDescriptor {
        label: Some("capture-readback"),
        size: u64::from(padded_bpr) * u64::from(height),
        usage: wgpu::BufferUsages::MAP_READ | wgpu::BufferUsages::COPY_DST,
        mapped_at_creation: false,
    });

    let mut enc = gpu
        .device
        .create_command_encoder(&wgpu::CommandEncoderDescriptor { label: Some("capture-copy") });
    enc.copy_texture_to_buffer(
        texture.as_image_copy(),
        wgpu::TexelCopyBufferInfo {
            buffer: &readback,
            layout: wgpu::TexelCopyBufferLayout {
                offset: 0,
                bytes_per_row: Some(padded_bpr),
                rows_per_image: None,
            },
        },
        extent,
    );
    gpu.queue.submit([enc.finish()]);

    let slice = readback.slice(..);
    let (tx, rx) = std::sync::mpsc::channel();
    slice.map_async(wgpu::MapMode::Read, move |res| {
        let _ = tx.send(res);
    });
    gpu.device
        .poll(wgpu::PollType::wait_indefinitely())
        .map_err(|e| CaptureError::Map(e.to_string()))?;
    rx.recv()
        .map_err(|e| CaptureError::Map(e.to_string()))?
        .map_err(|e| CaptureError::Map(e.to_string()))?;

    let mut pixels = Vec::with_capacity(unpadded_bpr as usize * height as usize);
    {
        let mapped = slice.get_mapped_range();
        for row in mapped.chunks_exact(padded_bpr as usize) {
            pixels.extend_from_slice(&row[..unpadded_bpr as usize]);
        }
    }
    readback.unmap();

    if bgra {
        for px in pixels.chunks_exact_mut(BPP as usize) {
            px.swap(0, 2);
        }
    }

    let img = image::RgbaImage::from_raw(width, height, pixels)
        .ok_or_else(|| CaptureError::Encode("pixel buffer size mismatch".into()))?;
    let mut out = Vec::new();
    img.write_to(&mut std::io::Cursor::new(&mut out), image::ImageFormat::Png)
        .map_err(|e| CaptureError::Encode(e.to_string()))?;
    Ok(out)
}
