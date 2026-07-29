//! The GPU wire format, and the pooling that assembles a scene into it.
//!
//! Three layouts are a binary contract with WGSL and must not drift:
//! [`PackedSegment`] (12 bytes) mirrors `digital.wgsl`'s segment storage buffer,
//! [`RowInfo`] (28 bytes) mirrors the `RowInfo` struct in both `digital.wgsl` and
//! `labels.wgsl`, and the two pools are byte-strided at `ceil(bit_width / 8)`.
//!
//! The pools carry tide's `min` plane and its unknown mask (`min ^ max`), which
//! is all the shader reads: it OR-folds each sample to "is the value non-zero"
//! and "does it hold any x or z", and picks a line level or a crosshatch from
//! that. Telling x from z needs the third plane and happens CPU-side, in
//! [`label`] and in the renderer's value column.

use crate::label::{self, EnumEntry, Radix};
use tide_core::metadata::Width;

pub const FLAG_SHADE: u32 = 1 << 16;
pub const FLAG_RIGHT_EDGE: u32 = 1 << 17;
pub const FLAG_RISING_EDGE: u32 = 1 << 18;
pub const FLAG_FALLING_EDGE: u32 = 1 << 19;
pub const FLAG_MUTE: u32 = 1 << 20;
pub const FLAG_RISING_EDGE_LEFT: u32 = 1 << 21;
pub const FLAG_FALLING_EDGE_LEFT: u32 = 1 << 22;

/// Timing plus the row index and edge/shade bits. Values live in the shared
/// pools, addressed through [`RowInfo`]: a segment's sample index within its row
/// is `instance_index - RowInfo::segment_start`.
#[derive(Clone, Copy, Default, PartialEq, Eq, Debug)]
#[repr(C)]
pub struct PackedSegment {
    pub t_start: u32,
    pub t_end: u32,
    /// `[15:0]` row index, `[22:16]` the `FLAG_*` bits above.
    pub row_flags: u32,
}

/// The shader reads three words per segment; drifting the stride silently
/// misreads the whole buffer.
const _: () = assert!(size_of::<PackedSegment>() == 12);

/// Per-row metadata, indexed by row.
#[derive(Clone, Copy, Default, PartialEq, Eq, Debug)]
#[repr(C)]
pub struct RowInfo {
    /// Byte offset into the value pool.
    pub x0_offset: u32,
    /// Byte offset into the unknown-mask pool.
    pub x1_offset: u32,
    /// `ceil(bit_width / 8)`, the same stride as tide's `Type::bytes`. Zero marks
    /// a row nothing was placed at.
    pub bytes_per_sample: u32,
    /// This row's first instance index within its pipeline.
    pub segment_start: u32,
    /// Per-row render flags (bit 0 dims the row). Always emitted as zero: the
    /// renderer writes these straight into the GPU buffer on an eye toggle, with
    /// no repack.
    pub flags: u32,
    /// Row top in canvas space, CSS px as f32 bits. Always emitted as zero — the
    /// renderer owns live layout, same as `flags`.
    pub y_offset: u32,
    /// Row height, CSS px as f32 bits. Always emitted as zero.
    pub height: u32,
}

/// Seven words per row, mirrored in `digital.wgsl` and `labels.wgsl`.
const _: () = assert!(size_of::<RowInfo>() == 28);

/// Bounded by the 16-bit row field in `PackedSegment::row_flags`. The renderer's
/// `gpu/colors.ts` `MAX_ROWS` must match.
pub const MAX_ROWS: u32 = 65535;

/// Bytes one sample of a `width`-bit signal occupies in the pools.
pub fn bytes_per_sample(width: Width) -> u32 {
    debug_assert!(width >= 1);
    width.div_ceil(8)
}

/// `ceil(width / 32)`, the word count used only by the CPU value path
/// (`getValueAt`), which keeps its word-array shape independently of the pools.
pub fn words_per_sample(width: Width) -> u32 {
    debug_assert!(width >= 1);
    width.div_ceil(32)
}

/// One packed signal, independent of the row it lands on: the row bits of every
/// `row_flags` are zero until placement.
///
/// `values`/`unknowns` hold `segments.len() * bytes_per_sample` bytes.
/// `label_offsets`
/// holds `segments.len() + 1` prefix offsets once any label is pushed, so label
/// `i` is `label_bytes[offsets[i]..offsets[i + 1]]`; it stays empty for an
/// unlabeled (binary) row.
#[derive(Default)]
pub struct PackedSignal {
    pub is_multi: bool,
    pub bit_width: Width,
    pub segments: Vec<PackedSegment>,
    pub values: Vec<u8>,
    pub unknowns: Vec<u8>,
    pub label_bytes: Vec<u8>,
    pub label_offsets: Vec<u32>,
}

impl PackedSignal {
    pub fn new(is_multi: bool, bit_width: Width) -> PackedSignal {
        PackedSignal {
            is_multi,
            bit_width,
            ..PackedSignal::default()
        }
    }

    /// Appends one transition's timing and flags. `flags` must carry no row bits.
    pub fn push_segment(&mut self, t_start: u32, t_end: u32, flags: u32) {
        self.segments.push(PackedSegment {
            t_start,
            t_end,
            row_flags: flags,
        });
    }

    /// Copies a chunk's whole value plane into the pools, deriving the unknown
    /// mask as it goes. Call once, after every `push_segment`: the i-th
    /// `bytes_per_sample` run then lines up with segment i.
    pub fn set_samples(&mut self, min: &[u8], max: &[u8]) {
        debug_assert_eq!(min.len(), max.len(), "plane lengths");
        self.values.extend_from_slice(min);
        self.unknowns
            .extend(min.iter().zip(max).map(|(low, high)| low ^ high));
    }

    /// Appends this segment's value label. Call once per `push_segment`, in
    /// order. A muted segment writes no bytes but still takes an offset slot, so
    /// label i stays aligned with segment i.
    pub fn push_label(
        &mut self,
        sample: (&[u8], &[u8], &[u8]),
        radix: Radix,
        enums: &[EnumEntry],
        muted: bool,
    ) {
        if self.label_offsets.is_empty() {
            self.label_offsets.push(0);
        }
        if !muted {
            let (min, max, z) = sample;
            let width = self.bit_width;
            label::format_value(&mut self.label_bytes, min, max, z, width, radix, enums);
        }
        self.label_offsets.push(self.label_bytes.len() as u32);
    }
}

/// Accumulates one row's samples while a scene is being assembled.
#[derive(Default)]
struct RowAccum {
    /// Zero marks an unused row.
    bit_width: Width,
    segment_start: u32,
    started: bool,
    /// Samples pushed; the pools hold `count * bytes_per_sample` bytes each.
    count: u32,
    values: Vec<u8>,
    unknowns: Vec<u8>,
}

/// Every placed signal, split by pipeline, plus the per-row sample accumulators.
///
/// Labels are routed to the stream matching the signal's pipeline. The single
/// stream carries an entry for *every* single segment — empty for the unlabeled
/// binary rows — so the label batch can index labels by segment index.
#[derive(Default)]
pub struct Scene {
    pub multi: Vec<PackedSegment>,
    pub single: Vec<PackedSegment>,
    pub multi_label_bytes: Vec<u8>,
    pub multi_label_offsets: Vec<u32>,
    pub single_label_bytes: Vec<u8>,
    pub single_label_offsets: Vec<u32>,
    /// Grown on demand to the highest placed row plus one. Gaps stay default and
    /// finalize emits an empty `RowInfo` for them.
    rows: Vec<RowAccum>,
}

/// Which pipeline a signal's segments join.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Pipeline {
    Single,
    Multi,
}

impl Scene {
    pub fn new() -> Scene {
        Scene::default()
    }

    /// Places an already packed signal at `row`: its segments join the pipeline
    /// its radix chose, its samples join the row's pool, and its labels join the
    /// matching label stream.
    ///
    /// # Panics
    /// If `row` is out of range, or a signal was already placed there — one
    /// signal fills a row, contiguously.
    pub fn push_packed_signal(&mut self, row: u32, signal: &PackedSignal) {
        assert!(row < MAX_ROWS, "row {row} past MAX_ROWS");
        // An empty signal contributes no row data, so the row stays unpopulated
        // and finalize emits a zeroed RowInfo for it.
        if signal.segments.is_empty() {
            return;
        }

        let index = row as usize;
        if self.rows.len() <= index {
            self.rows.resize_with(index + 1, RowAccum::default);
        }

        let pipeline = if signal.is_multi {
            Pipeline::Multi
        } else {
            Pipeline::Single
        };
        let target = match pipeline {
            Pipeline::Multi => &mut self.multi,
            Pipeline::Single => &mut self.single,
        };

        let accum = &mut self.rows[index];
        assert!(!accum.started, "row {row} already holds a signal");
        accum.bit_width = signal.bit_width;
        accum.segment_start = target.len() as u32;
        accum.started = true;

        target.extend(signal.segments.iter().map(|segment| PackedSegment {
            t_start: segment.t_start,
            t_end: segment.t_end,
            row_flags: (segment.row_flags & !0xffff) | (row & 0xffff),
        }));

        // One signal fills a row, so the accumulator starts empty and this is a
        // single copy of the whole byte run.
        accum.values.extend_from_slice(&signal.values);
        accum.unknowns.extend_from_slice(&signal.unknowns);
        accum.count += signal.segments.len() as u32;
        debug_assert_eq!(
            accum.values.len() as u32,
            accum.count * bytes_per_sample(accum.bit_width),
            "row {row} sample stride drift",
        );

        let (bytes, offsets) = match pipeline {
            Pipeline::Multi => (&mut self.multi_label_bytes, &mut self.multi_label_offsets),
            Pipeline::Single => (&mut self.single_label_bytes, &mut self.single_label_offsets),
        };
        if offsets.is_empty() {
            offsets.push(0);
        }
        let labeled = !signal.label_offsets.is_empty();
        for i in 0..signal.segments.len() {
            if labeled {
                let lo = signal.label_offsets[i] as usize;
                let hi = signal.label_offsets[i + 1] as usize;
                bytes.extend_from_slice(&signal.label_bytes[lo..hi]);
            }
            offsets.push(bytes.len() as u32);
        }
    }

    /// Concatenates the per-row sample runs into the two shared pools and emits
    /// one `RowInfo` per row up to the highest populated one.
    ///
    /// # Panics
    /// If a segment names a row with no samples behind it. `decodeSample` in the
    /// shader loops `bytes_per_sample` times, so a zero there would leave the
    /// decoded value undefined; catching it once at scene build beats a garbled
    /// frame.
    pub fn finalize(&self) -> Finalized {
        let row_count = self
            .rows
            .iter()
            .rposition(|row| row.bit_width != 0)
            .map_or(0, |index| index + 1);

        let mut row_infos = Vec::with_capacity(row_count);
        let mut x0_pool = Vec::new();
        let mut x1_pool = Vec::new();

        for row in &self.rows[..row_count] {
            if row.bit_width == 0 {
                row_infos.push(RowInfo::default());
                continue;
            }
            let x0_offset = x0_pool.len() as u32;
            x0_pool.extend_from_slice(&row.values);
            let x1_offset = x1_pool.len() as u32;
            x1_pool.extend_from_slice(&row.unknowns);
            row_infos.push(RowInfo {
                x0_offset,
                x1_offset,
                bytes_per_sample: bytes_per_sample(row.bit_width),
                segment_start: row.segment_start,
                ..RowInfo::default()
            });
        }

        // WebGPU's writeBuffer needs a four-byte multiple and the shader binds the
        // pools as array<u32>. One pad per pool, not per row, so inter-row byte
        // offsets are untouched and the zeros sit past every sample's run.
        x0_pool.resize(x0_pool.len().next_multiple_of(4), 0);
        x1_pool.resize(x1_pool.len().next_multiple_of(4), 0);

        for segment in self.multi.iter().chain(&self.single) {
            let row = (segment.row_flags & 0xffff) as usize;
            assert!(
                row < row_infos.len(),
                "segment names row {row} with no info"
            );
            assert!(
                row_infos[row].bytes_per_sample > 0,
                "segment names unpopulated row {row}",
            );
        }

        Finalized {
            row_infos,
            x0_pool,
            x1_pool,
        }
    }
}

/// The scene's per-row metadata and shared sample pools, ready for the GPU.
pub struct Finalized {
    pub row_infos: Vec<RowInfo>,
    pub x0_pool: Vec<u8>,
    pub x1_pool: Vec<u8>,
}

/// A `#[repr(C)]` record array as the bytes the GPU reads. Both layouts are
/// plain `u32` fields, so this is the host's little-endian representation with no
/// padding to skip.
///
/// # Safety
/// `T` must be a `#[repr(C)]` struct of `u32` fields only.
unsafe fn record_bytes<T>(records: &[T]) -> &[u8] {
    // SAFETY: the caller guarantees T is a padding-free struct of u32s, so every
    // byte of the array is initialized and any bit pattern is valid as u8.
    unsafe { std::slice::from_raw_parts(records.as_ptr().cast::<u8>(), size_of_val(records)) }
}

pub fn segment_bytes(segments: &[PackedSegment]) -> &[u8] {
    // SAFETY: PackedSegment is #[repr(C)] with three u32 fields.
    unsafe { record_bytes(segments) }
}

pub fn row_info_bytes(rows: &[RowInfo]) -> &[u8] {
    // SAFETY: RowInfo is #[repr(C)] with seven u32 fields.
    unsafe { record_bytes(rows) }
}

/// A `u32` slice as the bytes the GPU reads, for the label offset arrays.
pub fn word_bytes(words: &[u32]) -> &[u8] {
    // SAFETY: u32 has no padding and every bit pattern is a valid u8.
    unsafe { std::slice::from_raw_parts(words.as_ptr().cast::<u8>(), size_of_val(words)) }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A signal of `count` one-byte-wide segments, all flagless.
    fn signal(is_multi: bool, width: Width, count: usize) -> PackedSignal {
        let mut signal = PackedSignal::new(is_multi, width);
        let stride = bytes_per_sample(width) as usize;
        for i in 0..count {
            signal.push_segment(i as u32 * 10, (i as u32 + 1) * 10, 0);
        }
        let values = vec![0xaa; count * stride];
        signal.set_samples(&values, &values);
        signal
    }

    #[test]
    fn record_layouts_match_the_shader() {
        // digital.wgsl reads three words per segment and seven per row; drifting
        // either stride silently misreads every buffer. The struct sizes are
        // pinned at compile time, so this covers the byte views over them.
        assert_eq!(12, segment_bytes(&[PackedSegment::default()]).len());
        assert_eq!(28, row_info_bytes(&[RowInfo::default()]).len());
    }

    #[test]
    fn placement_ors_the_row_into_every_segment() {
        let mut scene = Scene::new();
        scene.push_packed_signal(3, &signal(false, 1, 2));
        assert_eq!(2, scene.single.len());
        for segment in &scene.single {
            assert_eq!(3, segment.row_flags & 0xffff);
        }

        // Flags above bit 15 survive; the row replaces only the low half.
        let mut flagged = signal(false, 1, 1);
        flagged.segments[0].row_flags = FLAG_SHADE | FLAG_RIGHT_EDGE;
        scene.push_packed_signal(4, &flagged);
        let placed = scene.single[2];
        assert_eq!(4, placed.row_flags & 0xffff);
        assert_eq!(FLAG_SHADE | FLAG_RIGHT_EDGE, placed.row_flags & !0xffff);
    }

    #[test]
    fn rows_are_pooled_in_order_with_gaps_left_empty() {
        let mut scene = Scene::new();
        // Row 0 is left unplaced, so it must still get a zeroed RowInfo.
        scene.push_packed_signal(1, &signal(true, 16, 2));
        scene.push_packed_signal(2, &signal(true, 8, 3));

        let final_scene = scene.finalize();
        assert_eq!(3, final_scene.row_infos.len());
        assert_eq!(RowInfo::default(), final_scene.row_infos[0]);

        let (first, second) = (final_scene.row_infos[1], final_scene.row_infos[2]);
        assert_eq!(2, first.bytes_per_sample);
        assert_eq!(0, first.x0_offset);
        assert_eq!(0, first.segment_start);
        assert_eq!(1, second.bytes_per_sample);
        // Row 1 wrote two 2-byte samples, so row 2 starts four bytes in.
        assert_eq!(4, second.x0_offset);
        assert_eq!(2, second.segment_start);
    }

    #[test]
    fn pools_are_padded_to_a_word() {
        let mut scene = Scene::new();
        // Three one-byte samples is not a multiple of four.
        scene.push_packed_signal(0, &signal(false, 8, 3));
        let final_scene = scene.finalize();
        assert_eq!(4, final_scene.x0_pool.len());
        assert_eq!(4, final_scene.x1_pool.len());
        assert_eq!(0, final_scene.x0_pool[3]);
    }

    #[test]
    fn every_segment_gets_a_label_offset_even_when_unlabeled() {
        let mut scene = Scene::new();
        // A binary row pushes no labels at all, but the batch still indexes
        // labels by segment index, so the offsets must keep pace.
        scene.push_packed_signal(0, &signal(false, 1, 3));
        assert_eq!(vec![0, 0, 0, 0], scene.single_label_offsets);
        assert!(scene.single_label_bytes.is_empty());

        let mut labeled = PackedSignal::new(true, 8);
        for i in 0..2 {
            labeled.push_segment(i, i + 1, 0);
            labeled.push_label((&[0xab], &[0xab], &[0x00]), Radix::Hex, &[], false);
        }
        labeled.set_samples(&[0xab, 0xab], &[0xab, 0xab]);
        scene.push_packed_signal(1, &labeled);
        assert_eq!(vec![0, 4, 8], scene.multi_label_offsets);
        assert_eq!(b"0xAB0xAB", scene.multi_label_bytes.as_slice());
    }

    #[test]
    fn an_empty_signal_leaves_its_row_unpopulated() {
        let mut scene = Scene::new();
        scene.push_packed_signal(0, &PackedSignal::new(false, 8));
        // Nothing placed anywhere, so there are no rows to describe.
        assert_eq!(0, scene.finalize().row_infos.len());
    }

    #[test]
    #[should_panic(expected = "already holds a signal")]
    fn two_signals_cannot_share_a_row() {
        let mut scene = Scene::new();
        scene.push_packed_signal(0, &signal(false, 1, 1));
        scene.push_packed_signal(0, &signal(false, 1, 1));
    }
}
