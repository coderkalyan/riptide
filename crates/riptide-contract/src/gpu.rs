//! CPU↔GPU buffer layouts. Byte-for-byte ports of `native/src/segments.zig`
//! and `src/renderer/gpu/data.ts`. Must stay in sync with `digital.wgsl` /
//! `labels.wgsl` (`PackedSegment`, `RowInfo`, `Viewport` structs).

use bytemuck::{Pod, Zeroable};

/// Max active signal rows (mirrors `segments.zig MAX_ROWS` / `gpu/colors.ts`).
pub const MAX_ROWS: usize = 64;

// Segment row_flags bit assignments (bits [15:0] = row index).
pub const FLAG_SHADE: u32 = 1 << 16;
pub const FLAG_RIGHT_EDGE: u32 = 1 << 17;
pub const FLAG_RISING_EDGE: u32 = 1 << 18;
pub const FLAG_FALLING_EDGE: u32 = 1 << 19;
pub const FLAG_MUTE: u32 = 1 << 20;
pub const FLAG_RISING_EDGE_LEFT: u32 = 1 << 21;
pub const FLAG_FALLING_EDGE_LEFT: u32 = 1 << 22;

// Per-row RowInfo.flags bits, patched live by the renderer (no repack).
pub const ROW_FLAG_DIM: u32 = 1 << 0;
pub const ROW_FLAG_HIGHLIGHT: u32 = 1 << 1;

/// One drawn segment: timing + row/flag bits. 3×u32 = 12 B. Values live in the
/// shared sample pools, indexed via [`RowInfo`]
/// (sample index = instance_index - RowInfo.segment_start).
#[repr(C)]
#[derive(Clone, Copy, Debug, PartialEq, Eq, Pod, Zeroable, serde::Serialize, serde::Deserialize)]
pub struct PackedSegment {
    pub t_start: u32,
    pub t_end: u32,
    pub row_flags: u32,
}

/// Per-row metadata, 7×u32 = 28 B. `x0_offset`/`x1_offset` are BYTE offsets
/// into the (u32-bound) pools; `bytes_per_sample = ceil(bit_width/8)` (tide's
/// per-sample stride); `segment_start` is the row's first instance index within
/// its pipeline. `flags` ([`ROW_FLAG_DIM`]/[`ROW_FLAG_HIGHLIGHT`]) and the
/// vertical layout (`y_offset`/`height`, CSS px stored as f32 bits) are emitted
/// as 0 by packing and patched directly in the GPU buffer by the renderer.
#[repr(C)]
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Pod, Zeroable, serde::Serialize, serde::Deserialize)]
pub struct RowInfo {
    pub x0_offset: u32,
    pub x1_offset: u32,
    pub bytes_per_sample: u32,
    pub segment_start: u32,
    pub flags: u32,
    pub y_offset: u32,
    pub height: u32,
}

pub const ROW_INFO_WORDS: usize = 7;

/// Bytes per sample in the pools — tide's native stride, ceil(width/8).
pub fn bytes_per_sample(width: u32) -> u32 {
    debug_assert!(width >= 1);
    width.div_ceil(8)
}

/// The 48-byte frame uniform (12×4 B, 16-aligned). All dims are CSS px (the
/// CSS-pixel + DPR contract: shaders never multiply sizes by dpr). start_ticks
/// is split int/frac so shader subtraction keeps full integer precision past
/// 2^24 ticks. Mirrors `gpu/data.ts writeViewportInto` and the WGSL `Viewport`.
#[repr(C)]
#[derive(Clone, Copy, Debug, Pod, Zeroable)]
pub struct ViewportUniform {
    pub ticks_per_pixel: f32,
    pub start_ticks_int: i32,
    pub start_ticks_frac: f32,
    pub width: f32,
    pub height: f32,
    pub row_height: f32,
    pub dpr: f32,
    pub selected_row: i32,
    pub wave_y_offset: f32,
    pub _pad: [f32; 3],
}

pub const VIEWPORT_BYTES: usize = 48;

impl ViewportUniform {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        ticks_per_pixel: f32,
        start_ticks: f64,
        width: f32,
        height: f32,
        row_height: f32,
        dpr: f32,
        selected_row: i32,
        wave_y_offset: f32,
    ) -> Self {
        let start_int = start_ticks.floor();
        Self {
            ticks_per_pixel,
            start_ticks_int: start_int as i32,
            start_ticks_frac: (start_ticks - start_int) as f32,
            width,
            height,
            row_height,
            dpr,
            selected_row,
            wave_y_offset,
            _pad: [0.0; 3],
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn layout_sizes() {
        assert_eq!(std::mem::size_of::<PackedSegment>(), 12);
        assert_eq!(std::mem::size_of::<RowInfo>(), 28);
        assert_eq!(std::mem::size_of::<ViewportUniform>(), VIEWPORT_BYTES);
    }

    #[test]
    fn stride() {
        assert_eq!(bytes_per_sample(1), 1);
        assert_eq!(bytes_per_sample(8), 1);
        assert_eq!(bytes_per_sample(9), 2);
        assert_eq!(bytes_per_sample(128), 16);
    }
}
