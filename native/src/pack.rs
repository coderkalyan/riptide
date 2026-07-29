//! Turning a signal's transitions into GPU segments.
//!
//! One transition becomes one [`PackedSegment`], so the whole byte plane a query
//! yields can be copied into the value pools in one go and sample `i` still lines
//! up with segment `i`. The muted path is the exception: it splits on the mute
//! signal's edges too, so its segments no longer match the data query one for one
//! and each copies its own sample.

use tide_core::Samples;
use tide_core::cursor::Chunk;
use tide_core::metadata::{Id, Timestamp, Width};
use tide_core::{Database, Sample};

use crate::label::{EnumEntry, Radix};
use crate::segments::{self, PackedSignal};

/// Whether a row draws a data waveform or a clock.
#[derive(Clone, Copy, PartialEq, Eq, Debug, Default)]
pub enum PackKind {
    #[default]
    Data,
    Clk,
}

/// Which clock edges get a chevron. Mirrors the renderer's `ClockPolarity`.
#[derive(Clone, Copy, PartialEq, Eq, Debug, Default)]
pub enum ClockPolarity {
    #[default]
    Rising,
    Falling,
    Both,
}

impl ClockPolarity {
    pub fn parse(name: &str) -> ClockPolarity {
        match name {
            "falling" => ClockPolarity::Falling,
            "both" => ClockPolarity::Both,
            _ => ClockPolarity::Rising,
        }
    }
}

/// GPU segment ticks carry the low 32 bits of tide's `u64` timestamp. The shader
/// positions each endpoint as an `i32` delta from `start_ticks`, and `i32`
/// subtraction wraps mod 2^32, so the wrapped low word is correct for any segment
/// whose *span* fits `i32`. A wider one renders at a garbled or negative x, so
/// trip loudly rather than corrupt the frame. The real fix is a 64-bit GPU tick
/// pipeline; see PERFORMANCE.md.
const MAX_SEGMENT_SPAN: u64 = 0x7fff_ffff;

fn renderable_span(t_start: Timestamp, t_end: Timestamp) -> (u32, u32) {
    assert!(t_end >= t_start, "segment ends before it starts");
    assert!(
        t_end - t_start <= MAX_SEGMENT_SPAN,
        "segment spans {} ticks, past the 32-bit GPU tick pipeline",
        t_end - t_start,
    );
    (t_start as u32, t_end as u32)
}

/// Everything about a row that is not the signal's own samples.
pub struct PackOpts<'a> {
    pub shaded: bool,
    /// The trace's end. The last segment extends to it.
    pub end_t: Timestamp,
    pub kind: PackKind,
    pub polarity: ClockPolarity,
    /// A signal gating this row: the row dims wherever it is not logic one.
    pub mute: Option<Id>,
    /// The packing window. The muted path runs a second query over it.
    pub q_start: Timestamp,
    pub q_end: Timestamp,
    pub radix: Radix,
    pub enums: &'a [EnumEntry],
}

/// Whether any bit of a sample is x or z. The bounds disagree exactly there.
fn any_unknown(min: &[u8], max: &[u8]) -> bool {
    min.iter().zip(max).any(|(low, high)| low != high)
}

/// Whether a mute sample gates its row. Logic one is the only ungated state, so
/// zero, x and z all mute.
fn sample_mutes(min: &[u8], max: &[u8]) -> bool {
    let is_one = min.first() == Some(&1) && !any_unknown(min, max);
    !is_one
}

/// Runs `f` over the sample of `id` active at `t`, plus the signal's declared
/// width. `None` when the signal is unknown or has no sample at or before `t`.
///
/// The sample borrows the database, so it is handed to a callback rather than
/// returned: nothing has to be copied for a caller that only reads it.
pub fn with_value_at<T>(
    db: &Database,
    id: Id,
    t: Timestamp,
    f: impl FnOnce(Sample<'_>, Width) -> T,
) -> Option<T> {
    let mut cursor = db.samples(id, t, t)?;
    let width = cursor.ty().width();
    let sample = cursor.next_sample()?;
    Some(f(sample, width))
}

/// Packs the transitions of `id` over `[q_start, q_end]` into a row-agnostic
/// signal. The caller places it at a row with `Scene::push_packed_signal`.
///
/// An unknown signal, or one with no sample at or before the window, yields an
/// empty result rather than an error: the hierarchy lists variables the database
/// never stored (reals, never-assigned nets), and a row holding one should render
/// as blank, not abort the frame.
pub fn pack_signal(db: &Database, id: Id, opts: &PackOpts) -> PackedSignal {
    let Some(mut cursor) = db.samples(id, opts.q_start, opts.q_end) else {
        return PackedSignal::new(opts.radix.is_multi(), 0);
    };
    let ty = cursor.ty();
    let Some(data) = cursor.next_chunk() else {
        return PackedSignal::new(opts.radix.is_multi(), ty.width());
    };

    // A muted data signal must split on the mute signal's edges as well as its
    // own, or a gate toggling between two value changes would never flip the row
    // mid-segment. Clocks are never muted — they define the timebase — and an
    // unresolvable or silent mute signal falls back to the plain walk.
    if opts.kind == PackKind::Data
        && let Some(mute_id) = opts.mute
        && let Some(mut mute_cursor) = db.samples(mute_id, opts.q_start, opts.q_end)
    {
        let mute_bytes = mute_cursor.ty().bytes();
        if let Some(mute) = mute_cursor.next_chunk() {
            return pack_muted_data(&data, &mute, mute_bytes, opts);
        }
    }

    pack_plain(&data, opts)
}

/// One segment per transition, and one bulk copy of the value plane.
fn pack_plain(data: &Chunk<'_>, opts: &PackOpts) -> PackedSignal {
    let width = data.width();
    let bytes = data.ty().bytes();
    let times = data.times();
    let (mins, maxes, zs) = data.planes();
    let len = times.len();

    let mut packed = PackedSignal::new(opts.radix.is_multi(), width);
    packed.segments.reserve(len);

    for i in 0..len {
        let t_end_u = if i + 1 < len {
            times[i + 1]
        } else {
            opts.end_t
        };
        let (t_start, t_end) = renderable_span(times[i], t_end_u);
        let has_next = i + 1 < len;

        let sample = i * bytes..(i + 1) * bytes;
        let (min, max, z) = (&mins[sample.clone()], &maxes[sample.clone()], &zs[sample]);

        let mut draw_right = has_next;
        let (mut rising, mut rising_left) = (false, false);
        let (mut falling, mut falling_left) = (false, false);

        match opts.kind {
            PackKind::Clk => {
                // A chevron straddles each edge, split across the two abutting
                // half-periods: the half before an edge draws the left arm at its
                // right boundary, the half after draws the right arm at its left
                // boundary. The left-arm halves need a next half-period to abut,
                // and the right-arm ones need an in-window predecessor — the
                // window's first sample either sits offscreen-left or, at tick 0,
                // is a value init rather than a transition.
                //
                // A clock is one bit, and an unknown reads as low — masking the
                // bounds apart keeps an x from charting as a level it never held.
                let low = min.first().copied().unwrap_or(0);
                let high = max.first().copied().unwrap_or(0);
                let value = low & !(low ^ high) & 1;
                let want_rise = opts.polarity != ClockPolarity::Falling;
                let want_fall = opts.polarity != ClockPolarity::Rising;
                rising = want_rise && value == 0 && has_next;
                rising_left = want_rise && value == 1 && i > 0;
                falling = want_fall && value == 1 && has_next;
                falling_left = want_fall && value == 0 && i > 0;
            }
            PackKind::Data => {
                // A single-pipeline transition touching x or z has no clean edge
                // to draw, so the left segment drops its right edge.
                let next = (i + 1) * bytes..(i + 2) * bytes;
                if draw_right
                    && !packed.is_multi
                    && (any_unknown(min, max) || any_unknown(&mins[next.clone()], &maxes[next]))
                {
                    draw_right = false;
                }
            }
        }

        let shaded = opts.shaded && opts.kind == PackKind::Data;
        // Row bits stay zero; they are OR'd in at placement.
        let flags = flag(shaded, segments::FLAG_SHADE)
            | flag(draw_right, segments::FLAG_RIGHT_EDGE)
            | flag(rising, segments::FLAG_RISING_EDGE)
            | flag(rising_left, segments::FLAG_RISING_EDGE_LEFT)
            | flag(falling, segments::FLAG_FALLING_EDGE)
            | flag(falling_left, segments::FLAG_FALLING_EDGE_LEFT);

        packed.push_segment(t_start, t_end, flags);
        if opts.radix.is_labeled() {
            packed.push_label((min, max, z), opts.radix, opts.enums, false);
        }
    }

    // The loop above computed only timing, flags and labels; the values go over
    // in one copy per plane, which is why segment i lines up with sample i.
    packed.set_samples(mins, maxes);
    packed
}

fn flag(set: bool, bit: u32) -> u32 {
    if set { bit } else { 0 }
}

/// A muted data signal: a segment boundary lands at every data value change *and*
/// every mute edge that flips the row's gating.
fn pack_muted_data(
    data: &Chunk<'_>,
    mute: &Chunk<'_>,
    mute_bytes: usize,
    opts: &PackOpts,
) -> PackedSignal {
    let width = data.width();
    let bytes = data.ty().bytes();
    let times = data.times();
    let planes = data.planes();
    let len = times.len();

    let mut packed = PackedSignal::new(opts.radix.is_multi(), width);
    if len == 0 {
        return packed;
    }

    // Reduce the mute chunk to timestamps and gating bits up front. Nothing then
    // borrows it during the data walk, and the enable is one bit wide, so a window
    // holds only a handful of these.
    let mute_times = mute.times();
    let (mute_mins, mute_maxes, _) = mute.planes();
    let mutes: Vec<bool> = (0..mute_times.len())
        .map(|k| {
            let sample = k * mute_bytes..(k + 1) * mute_bytes;
            sample_mutes(&mute_mins[sample.clone()], &mute_maxes[sample])
        })
        .collect();

    /// Gating at `t`: the mute sample active at or before it. Left of the first
    /// in-window sample the first one still applies, since it is the sample active
    /// at `q_start` and so covers everything to its left on screen.
    fn mute_at(times: &[Timestamp], mutes: &[bool], t: Timestamp) -> bool {
        match times.partition_point(|&time| time <= t) {
            0 => mutes[0],
            index => mutes[index - 1],
        }
    }

    // Walk the merged boundary timeline. A boundary emits a segment when it is a
    // real data change or the gating flips there; a mute edge that leaves the row
    // equally muted (0 to x, say) is skipped so a pill does not sprout a false
    // seam. The open segment's end is the next emitted boundary, or the trace end.
    let first_t = times[0];
    let mut di = 0usize;
    let mut mk = mute_times.partition_point(|&time| time <= first_t);

    let mut prev_muted = false;
    let mut have_prev = false;
    let mut open: Option<(Timestamp, usize, bool)> = None;

    loop {
        let dt = times.get(di).copied().unwrap_or(Timestamp::MAX);
        let mut mt = mute_times.get(mk).copied().unwrap_or(Timestamp::MAX);
        // A mute edge past the window is offscreen-right and splits nothing.
        if mt >= opts.end_t {
            mt = Timestamp::MAX;
        }
        let boundary = dt.min(mt);
        if boundary == Timestamp::MAX {
            break;
        }

        let is_data_edge = dt == boundary;
        // Step past this boundary so `di` describes the span starting at it.
        if dt == boundary {
            di += 1;
        }
        if mt == boundary {
            mk += 1;
        }
        let current_di = di - 1;
        let muted = mute_at(mute_times, &mutes, boundary);

        if have_prev && !is_data_edge && muted == prev_muted {
            continue;
        }

        if let Some((start, index, was_muted)) = open {
            push_muted_segment(
                &mut packed,
                planes,
                bytes,
                start,
                boundary,
                index,
                was_muted,
                opts,
                Some(current_di),
            );
        }
        open = Some((boundary, current_di, muted));
        prev_muted = muted;
        have_prev = true;
    }

    if let Some((start, index, was_muted)) = open {
        push_muted_segment(
            &mut packed,
            planes,
            bytes,
            start,
            opts.end_t,
            index,
            was_muted,
            opts,
            None,
        );
    }
    packed
}

/// Emits one muted-data segment, with the data sample active over its span.
///
/// A pill draws its right gap at every boundary including a mute-only one, since
/// the gap is what separates a valid value from a gated one. A line draws its
/// right edge only at a genuine value change into a clean sample: a mute-only
/// boundary keeps the same value, and the dim already conveys it.
#[expect(clippy::too_many_arguments, reason = "one call site, all of it timing")]
fn push_muted_segment(
    packed: &mut PackedSignal,
    planes: (&[u8], &[u8], &[u8]),
    bytes: usize,
    t_start: Timestamp,
    t_end: Timestamp,
    di: usize,
    muted: bool,
    opts: &PackOpts,
    next_di: Option<usize>,
) {
    let (mins, maxes, zs) = planes;
    let (t_start, t_end) = renderable_span(t_start, t_end);
    let sample = di * bytes..(di + 1) * bytes;
    let (min, max, z) = (&mins[sample.clone()], &maxes[sample.clone()], &zs[sample]);

    let draw_right = if packed.is_multi {
        next_di.is_some()
    } else {
        next_di.is_some_and(|next| {
            let following = next * bytes..(next + 1) * bytes;
            next != di
                && !any_unknown(min, max)
                && !any_unknown(&mins[following.clone()], &maxes[following])
        })
    };

    let flags = flag(opts.shaded, segments::FLAG_SHADE)
        | flag(draw_right, segments::FLAG_RIGHT_EDGE)
        | flag(muted, segments::FLAG_MUTE);

    packed.push_segment(t_start, t_end, flags);
    packed.values.extend_from_slice(min);
    packed
        .unknowns
        .extend(min.iter().zip(max).map(|(low, high)| low ^ high));
    if opts.radix.is_labeled() {
        packed.push_label((min, max, z), opts.radix, opts.enums, muted);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tide_core::metadata::{Builder, Type};

    /// The three planes of a value written most significant bit first, in
    /// four-state text. Every fixture here is eight bits or fewer, so one byte
    /// per plane covers it.
    fn planes(bits: &str) -> (u8, u8, u8) {
        let (mut min, mut max, mut z) = (0u8, 0u8, 0u8);
        for (index, digit) in bits.chars().rev().enumerate() {
            let (low, high, impedance) = match digit {
                '0' => (0, 0, 0),
                '1' => (1, 1, 0),
                'x' => (0, 1, 0),
                'z' => (0, 1, 1),
                other => panic!("not a four-state digit: {other}"),
            };
            min |= low << index;
            max |= high << index;
            z |= impedance << index;
        }
        (min, max, z)
    }

    /// One signal: its id, declared width, and samples as `(time, four-state
    /// text)`.
    type Fixture<'a> = (u64, Width, &'a [(Timestamp, &'a str)]);

    /// A database holding one signal per fixture entry.
    fn db(signals: &[Fixture<'_>]) -> Database {
        let mut db = Database::new();
        for &(id, width, samples) in signals {
            let mut builder = Builder::new(Id(id), Type::logic(width));
            for &(time, bits) in samples {
                let (min, max, z) = planes(bits);
                builder.push(time, &[min], &[max], &[z]);
            }
            db.insert(builder.build());
        }
        db
    }

    fn opts<'a>(kind: PackKind, radix: Radix, end_t: Timestamp) -> PackOpts<'a> {
        PackOpts {
            shaded: false,
            end_t,
            kind,
            polarity: ClockPolarity::Rising,
            mute: None,
            q_start: 0,
            q_end: end_t,
            radix,
            enums: &[],
        }
    }

    /// `(t_start, t_end, flags above bit 15)` per segment.
    fn shape(packed: &PackedSignal) -> Vec<(u32, u32, u32)> {
        packed
            .segments
            .iter()
            .map(|s| (s.t_start, s.t_end, s.row_flags & !0xffff))
            .collect()
    }

    #[test]
    fn one_segment_per_transition_reaching_the_trace_end() {
        let db = db(&[(1, 1, &[(0, "0"), (10, "1"), (20, "0")])]);
        let packed = pack_signal(&db, Id(1), &opts(PackKind::Data, Radix::Bin, 50));

        assert_eq!(
            vec![
                (0, 10, segments::FLAG_RIGHT_EDGE),
                (10, 20, segments::FLAG_RIGHT_EDGE),
                // The last segment has no successor, so no right edge, and it
                // runs to the trace end rather than to its own last tick.
                (20, 50, 0),
            ],
            shape(&packed),
        );
        // The value plane came over in bulk, one byte per sample, and nothing
        // in this signal is unknown.
        assert_eq!(vec![0, 1, 0], packed.values);
        assert_eq!(vec![0, 0, 0], packed.unknowns);
    }

    #[test]
    fn a_window_keeps_the_sample_active_at_its_left_edge() {
        let db = db(&[(1, 4, &[(0, "0001"), (100, "0010"), (200, "0011")])]);
        let mut o = opts(PackKind::Data, Radix::Hex, 300);
        (o.q_start, o.q_end) = (150, 250);

        // The value visible at 150 is the one written at 100, so that sample must
        // be in the pack or the left of the viewport would draw blank.
        let packed = pack_signal(&db, Id(1), &o);
        assert_eq!(
            vec![(100, 200, segments::FLAG_RIGHT_EDGE), (200, 300, 0)],
            shape(&packed)
        );
        assert_eq!(b"0x20x3", packed.label_bytes.as_slice());
    }

    #[test]
    fn transitions_touching_x_draw_no_edge_on_a_line() {
        let db = db(&[(1, 1, &[(0, "0"), (10, "x"), (20, "1")])]);
        let packed = pack_signal(&db, Id(1), &opts(PackKind::Data, Radix::Bin, 30));

        // 0 -> x and x -> 1 both touch an unknown, so neither gets a right edge.
        assert_eq!(vec![(0, 10, 0), (10, 20, 0), (20, 30, 0)], shape(&packed));
    }

    #[test]
    fn clock_chevrons_split_across_each_edge() {
        let db = db(&[(1, 1, &[(0, "0"), (5, "1"), (10, "0"), (15, "1")])]);
        let packed = pack_signal(&db, Id(1), &opts(PackKind::Clk, Radix::Bin, 20));

        let rise = segments::FLAG_RISING_EDGE;
        let rise_left = segments::FLAG_RISING_EDGE_LEFT;
        let edge = segments::FLAG_RIGHT_EDGE;
        assert_eq!(
            vec![
                // Low half before an edge: left arm only. No right arm, because
                // at tick 0 there is no earlier transition to straddle.
                (0, 5, edge | rise),
                // High half after the edge: right arm.
                (5, 10, edge | rise_left),
                (10, 15, edge | rise),
                (15, 20, rise_left),
            ],
            shape(&packed),
        );
    }

    #[test]
    fn falling_polarity_picks_the_other_edges() {
        let db = db(&[(1, 1, &[(0, "0"), (5, "1"), (10, "0")])]);
        let mut o = opts(PackKind::Clk, Radix::Bin, 20);
        o.polarity = ClockPolarity::Falling;
        let packed = pack_signal(&db, Id(1), &o);

        let fall = segments::FLAG_FALLING_EDGE;
        let fall_left = segments::FLAG_FALLING_EDGE_LEFT;
        let edge = segments::FLAG_RIGHT_EDGE;
        assert_eq!(
            vec![(0, 5, edge), (5, 10, edge | fall), (10, 20, fall_left)],
            shape(&packed)
        );
    }

    #[test]
    fn a_mute_edge_between_value_changes_splits_the_segment() {
        // Data holds 0xa from t=0 to t=40; the gate drops at t=10 and returns at
        // t=25. Without the merged walk the row would stay ungated the whole way.
        let db = db(&[
            (1, 4, &[(0, "1010"), (40, "1011")]),
            (2, 1, &[(0, "1"), (10, "0"), (25, "1")]),
        ]);
        let mut o = opts(PackKind::Data, Radix::Hex, 50);
        o.mute = Some(Id(2));
        o.q_end = 50;

        let packed = pack_signal(&db, Id(1), &o);
        let mute = segments::FLAG_MUTE;
        let edge = segments::FLAG_RIGHT_EDGE;
        assert_eq!(
            vec![
                (0, 10, edge),
                (10, 25, edge | mute),
                (25, 40, edge),
                (40, 50, 0)
            ],
            shape(&packed),
        );
        // A muted pill carries an empty label, but still takes an offset slot.
        assert_eq!(vec![0, 3, 3, 6, 9], packed.label_offsets);
        assert_eq!(b"0xA0xA0xB", packed.label_bytes.as_slice());
        // Segments no longer match the data query, so each carries its own sample.
        assert_eq!(vec![0xa, 0xa, 0xa, 0xb], packed.values);
    }

    #[test]
    fn a_mute_edge_that_does_not_change_gating_makes_no_seam() {
        // The gate goes 0 -> x, both of which mute, so nothing splits there.
        let db = db(&[(1, 4, &[(0, "1010")]), (2, 1, &[(0, "0"), (10, "x")])]);
        let mut o = opts(PackKind::Data, Radix::Hex, 50);
        o.mute = Some(Id(2));

        let packed = pack_signal(&db, Id(1), &o);
        assert_eq!(vec![(0, 50, segments::FLAG_MUTE)], shape(&packed));
    }

    #[test]
    fn an_unknown_signal_packs_to_nothing() {
        let known = db(&[(1, 1, &[(0, "0")])]);
        let packed = pack_signal(&known, Id(99), &opts(PackKind::Data, Radix::Bin, 10));
        assert!(packed.segments.is_empty());

        // So does a window that ends before the signal's first sample: the
        // hierarchy lists variables the database never stored, and a row holding
        // one renders blank instead of aborting the frame.
        let late = db(&[(1, 1, &[(100, "0")])]);
        let mut o = opts(PackKind::Data, Radix::Bin, 200);
        (o.q_start, o.q_end) = (0, 50);
        assert!(pack_signal(&late, Id(1), &o).segments.is_empty());
    }

    #[test]
    fn values_read_back_at_the_sample_active_at_a_tick() {
        let db = db(&[(1, 8, &[(0, "00010001"), (10, "00100010")])]);
        let read = |t| with_value_at(&db, Id(1), t, |sample, width| (sample.min[0], width));

        assert_eq!(Some((0x11, 8)), read(0));
        assert_eq!(Some((0x11, 8)), read(9));
        assert_eq!(Some((0x22, 8)), read(10));
        assert_eq!(Some((0x22, 8)), read(999));
        assert_eq!(None, with_value_at(&db, Id(99), 0, |_, _| ()));
    }

    #[test]
    fn a_tick_before_the_first_sample_has_no_value() {
        let db = db(&[(1, 8, &[(50, "00010001")])]);
        assert_eq!(None, with_value_at(&db, Id(1), 10, |_, _| ()));
    }
}
