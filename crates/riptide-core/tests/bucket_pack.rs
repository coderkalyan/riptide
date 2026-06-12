//! Unit U9 — bucket-pack tests against synthesized VCDs on disk.
//!
//! Label TEXT is never asserted (format_value is a stub until U3 merges);
//! only the offsets structure is.

use std::fmt::Write as _;
use std::path::PathBuf;

use riptide_core::TraceDb;
use riptide_core::pack::buckets::{RowBucketPack, pack_row_buckets, should_bucket};
use riptide_contract::gpu::{FLAG_RIGHT_EDGE, FLAG_SHADE};
use riptide_contract::spec::{ClockPolarity, PackKind, Radix, RowSpec};
use tide::SignalId;

// ---------------------------------------------------------------- helpers --

fn write_vcd(name: &str, content: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("riptide-u9-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let p = dir.join(name);
    std::fs::write(&p, content).unwrap();
    p
}

fn spec(row: u32, handle: SignalId, width: u32, radix: Radix) -> RowSpec {
    RowSpec {
        row,
        handle: handle.0.to_string(),
        path: String::new(),
        kind: PackKind::Data,
        polarity: ClockPolarity::Rising,
        shaded: false,
        mute_handle: None,
        radix,
        enums: vec![],
        color: 0,
        hidden: false,
        selected: false,
        height: None,
        divider_below: false,
        divider_height: None,
        bit_width: width,
    }
}

fn sig(db: &TraceDb, path: &str) -> SignalId {
    db.find(path).unwrap_or_else(|| panic!("signal {path} not found"))
}

/// All emitted items as `(t_start, t_end, is_band)`, sorted by start.
fn items(pack: &RowBucketPack) -> Vec<(u64, u64, bool)> {
    let mut v: Vec<(u64, u64, bool)> = pack
        .segments
        .iter()
        .map(|s| (s.t_start as u64, s.t_end as u64, false))
        .chain(pack.bands.iter().map(|b| (b.t_start, b.t_end, true)))
        .collect();
    v.sort_by_key(|&(s, e, _)| (s, e));
    v
}

/// Bands + segments must tile `[from, to]` exactly: contiguous, no overlap,
/// alternating kinds.
fn assert_partition(pack: &RowBucketPack, from: u64, to: u64) {
    let v = items(pack);
    assert!(!v.is_empty(), "no items emitted");
    assert_eq!(v[0].0, from, "first item must start at the window start");
    for w in v.windows(2) {
        assert_eq!(w[0].1, w[1].0, "gap/overlap between {:?} and {:?}", w[0], w[1]);
        assert_ne!(w[0].2, w[1].2, "adjacent runs of the same kind: {:?} {:?}", w[0], w[1]);
    }
    assert_eq!(v.last().unwrap().1, to, "last item must end at the window end");
}

/// The (p0, p1) planes of the sample in effect at `t`, zero-padded to `stride`
/// (absent planes read as zeros).
fn planes_at(db: &mut TraceDb, id: SignalId, t: u64, stride: usize) -> (Vec<u8>, Vec<u8>) {
    let r = db.value_at(&[id], t).unwrap();
    let s = r[0].expect("no sample at probe tick");
    let v = s.value.logic().expect("not a logic signal");
    let pad = |src: &[u8]| {
        let mut out = vec![0u8; stride];
        let n = src.len().min(stride);
        out[..n].copy_from_slice(&src[..n]);
        out
    };
    (pad(v.plane(0)), pad(v.plane(1)))
}

fn assert_label_offsets(pack: &RowBucketPack, expect_labels: usize) {
    assert_eq!(pack.label_offsets.len(), expect_labels + 1, "offsets are count+1");
    assert_eq!(pack.label_offsets[0], 0);
    for w in pack.label_offsets.windows(2) {
        assert!(w[0] <= w[1], "offsets must be non-decreasing");
    }
    assert_eq!(*pack.label_offsets.last().unwrap() as usize, pack.label_bytes.len());
}

fn packs_eq(a: &RowBucketPack, b: &RowBucketPack) -> bool {
    a.segments == b.segments
        && a.x0 == b.x0
        && a.x1 == b.x1
        && a.label_bytes == b.label_bytes
        && a.label_offsets == b.label_offsets
        && a.bands == b.bands
}

// --------------------------------------------------------------- fixtures --

const END: u64 = 100_000;

/// Fixture (a): `tgl` (1-bit, toggles every tick), `cnt` (8-bit, +1 every
/// 1000 ticks), `con` (1-bit constant 1), `slow` (1-bit, toggles every 1000).
fn dense_vcd(name: &str) -> PathBuf {
    let mut s = String::with_capacity(2 << 20);
    s.push_str("$version riptide u9 $end\n$timescale 1ns $end\n");
    s.push_str("$scope module top $end\n");
    s.push_str("$var wire 1 ! tgl $end\n");
    s.push_str("$var wire 8 \" cnt [7:0] $end\n");
    s.push_str("$var wire 1 # con $end\n");
    s.push_str("$var wire 1 % slow $end\n");
    s.push_str("$upscope $end\n$enddefinitions $end\n");
    s.push_str("#0\n$dumpvars\n0!\nb0 \"\n1#\n0%\n$end\n");
    let mut tgl = 0u8;
    let mut cnt = 0u32;
    let mut slow = 0u8;
    for t in 1..=END {
        writeln!(s, "#{t}").unwrap();
        tgl ^= 1;
        writeln!(s, "{tgl}!").unwrap();
        if t.is_multiple_of(1000) {
            cnt = cnt.wrapping_add(1) & 0xff;
            writeln!(s, "b{cnt:b} \"").unwrap();
            slow ^= 1;
            writeln!(s, "{slow}%").unwrap();
        }
    }
    write_vcd(name, &s)
}

/// Fixture (b): x/z-bearing signals. `sx` (1-bit: 0, x@10, 0@20, z@30, 1@40,
/// 0@300), `bus` (4-bit: 0000, xx01@100, 0010@110, zz11@200, 0100@210).
fn xz_vcd(name: &str) -> PathBuf {
    let s = "\
$version riptide u9 $end
$timescale 1ns $end
$scope module top $end
$var wire 1 ! sx $end
$var wire 4 \" bus $end
$upscope $end
$enddefinitions $end
#0
$dumpvars
0!
b0000 \"
$end
#10
x!
#20
0!
#30
z!
#40
1!
#100
bxx01 \"
#110
b0010 \"
#200
bzz11 \"
#210
b0100 \"
#300
0!
";
    write_vcd(name, s)
}

/// Fixture (c): the dump's first time marker is #10 — every signal's first
/// sample sits at t=10, so a window starting at 0 has `initial() == None`.
fn late_vcd(name: &str) -> PathBuf {
    let s = "\
$version riptide u9 $end
$timescale 1ns $end
$scope module top $end
$var wire 1 ! late $end
$upscope $end
$enddefinitions $end
#10
$dumpvars
0!
$end
#20
1!
#100
0!
";
    write_vcd(name, s)
}

// ------------------------------------------------------------------ tests --

#[test]
fn hysteresis_flips_at_8x_up_and_2x_down() {
    let px = 100.0f32;
    // Not bucketed: enters bucket mode strictly above 8×px transitions.
    assert!(!should_bucket(800, px, false));
    assert!(should_bucket(801, px, false));
    // Bucketed: stays bucketed until at/below 2×px.
    assert!(should_bucket(201, px, true));
    assert!(!should_bucket(200, px, true));
}

#[test]
fn dense_toggler_is_one_band() {
    let mut db = TraceDb::open(dense_vcd("dense_band.vcd")).unwrap();
    let id = sig(&db, "top.tgl");
    let pack = pack_row_buckets(&mut db, &spec(3, id, 1, Radix::Bin), 0, END, 16).unwrap();
    assert!(pack.segments.is_empty(), "all-busy row must emit no segments");
    assert_eq!(pack.bands.len(), 1, "all-busy row coalesces into one band");
    let b = pack.bands[0];
    assert_eq!((b.t_start, b.t_end), (0, END));
    assert_eq!(b.row, 3);
    assert!(!b.multi, "1-bit row");
    assert!(!b.has_x && !b.has_z);
    assert!(pack.x0.is_empty() && pack.x1.is_empty());
    assert_label_offsets(&pack, 0);
    assert_partition(&pack, 0, END);
}

#[test]
fn counter_bands_and_segments_partition_window() {
    let mut db = TraceDb::open(dense_vcd("cnt_partition.vcd")).unwrap();
    let id = sig(&db, "top.cnt");
    let pack = pack_row_buckets(&mut db, &spec(0, id, 8, Radix::Hex), 0, END, 64).unwrap();
    assert_partition(&pack, 0, END);
    assert!(!pack.bands.is_empty() && !pack.segments.is_empty());
    // One sample per emitted segment at the 8-bit stride.
    assert_eq!(pack.x0.len(), pack.segments.len());
    assert_eq!(pack.x1.len(), pack.segments.len());
    // Labeled (hex) row: one label per segment; structure only, no text.
    assert_label_offsets(&pack, pack.segments.len());
    // Multi rows draw the right gap whenever a next run exists. The counter's
    // last in-window run is busy (it changes at t=100000), so every segment
    // has a following band.
    for s in &pack.segments {
        assert_ne!(s.row_flags & FLAG_RIGHT_EDGE, 0, "multi quiet run before a band");
        assert_eq!(s.row_flags & !(FLAG_RIGHT_EDGE | FLAG_SHADE), 0, "row bits must stay 0");
    }
}

#[test]
fn quiet_segment_values_match_value_at() {
    let mut db = TraceDb::open(dense_vcd("cnt_values.vcd")).unwrap();
    let id = sig(&db, "top.cnt");
    let pack = pack_row_buckets(&mut db, &spec(0, id, 8, Radix::Hex), 0, END, 64).unwrap();
    assert!(pack.segments.len() > 10);
    for (i, s) in pack.segments.iter().enumerate() {
        let (t0, t1) = (s.t_start as u64, s.t_end as u64);
        // Probe the run start, the middle, and just before the end.
        for probe in [t0, t0 + (t1 - t0) / 2, t1.saturating_sub(1).max(t0)] {
            let (p0, p1) = planes_at(&mut db, id, probe, 1);
            assert_eq!(&pack.x0[i..=i], &p0[..], "x0 mismatch at tick {probe} (seg {i})");
            assert_eq!(&pack.x1[i..=i], &p1[..], "x1 mismatch at tick {probe} (seg {i})");
        }
    }
}

#[test]
fn single_bit_clean_right_edges() {
    let mut db = TraceDb::open(dense_vcd("slow_edges.vcd")).unwrap();
    let id = sig(&db, "top.slow");
    let pack = pack_row_buckets(&mut db, &spec(0, id, 1, Radix::Bin), 0, END, 64).unwrap();
    assert_partition(&pack, 0, END);
    // slow is 2-state and its last run is busy (edge at t=100000): every quiet
    // segment is followed by a clean band → right edge set on all of them.
    for s in &pack.segments {
        assert_ne!(s.row_flags & FLAG_RIGHT_EDGE, 0);
    }
    // Bin row: no labels.
    assert_label_offsets(&pack, 0);
    // Values alternate 0/1 between busy buckets — pin against value_at.
    for (i, s) in pack.segments.iter().enumerate() {
        let (p0, p1) = planes_at(&mut db, id, s.t_start as u64, 1);
        assert_eq!((pack.x0[i], pack.x1[i]), (p0[0], p1[0]));
    }
}

#[test]
fn all_quiet_is_one_segment() {
    let mut db = TraceDb::open(dense_vcd("con_quiet.vcd")).unwrap();
    let id = sig(&db, "top.con");
    let pack = pack_row_buckets(&mut db, &spec(0, id, 1, Radix::Bin), 10, 50_000, 10).unwrap();
    assert!(pack.bands.is_empty());
    assert_eq!(pack.segments.len(), 1, "all-quiet window is exactly one segment");
    let s = pack.segments[0];
    assert_eq!((s.t_start, s.t_end), (10, 50_000));
    assert_eq!(s.row_flags, 0, "no next run → no right edge; row bits 0");
    // con == 1 from the initial() covering sample (t=0, before the window).
    assert_eq!((pack.x0[0], pack.x1[0]), (1, 0));
    assert_partition(&pack, 10, 50_000);

    // Boolean radix is single-pipeline but labeled.
    let pack = pack_row_buckets(&mut db, &spec(0, id, 1, Radix::Boolean), 10, 50_000, 10).unwrap();
    assert_eq!(pack.segments.len(), 1);
    assert_label_offsets(&pack, 1);
}

#[test]
fn xz_flags_and_edge_suppression() {
    let mut db = TraceDb::open(xz_vcd("xz.vcd")).unwrap();
    let id = sig(&db, "top.sx");
    let pack = pack_row_buckets(&mut db, &spec(0, id, 1, Radix::Bin), 0, 300, 5).unwrap();
    assert_partition(&pack, 0, 300);

    // Bands: one per isolated busy bucket, x/z flags where injected.
    let band_at = |t: u64| {
        pack.bands
            .iter()
            .find(|b| b.t_start == t)
            .unwrap_or_else(|| panic!("no band at {t}"))
    };
    assert!(band_at(10).has_x && !band_at(10).has_z, "x injected at t=10");
    assert!(band_at(30).has_z && !band_at(30).has_x, "z injected at t=30");
    assert!(!band_at(20).has_x && !band_at(20).has_z, "clean 0 at t=20");

    // Segments: [5,10)=0, [15,20)=x, [25,30)=0, [35,40)=z, [45,300)=1.
    let seg = |t0: u32| {
        let i = pack
            .segments
            .iter()
            .position(|s| s.t_start == t0)
            .unwrap_or_else(|| panic!("no segment at {t0}"));
        (pack.segments[i], pack.x0[i], pack.x1[i])
    };
    // Carried x value: tide.rs planes X = (p0=1, p1=1); Z = (p0=0, p1=1).
    let (sx, x0, x1) = seg(15);
    assert_eq!((x0, x1), (1, 1), "x carried into the quiet run");
    assert_eq!(sx.row_flags & FLAG_RIGHT_EDGE, 0, "unknown value → edge suppressed");
    let (sz, x0, x1) = seg(35);
    assert_eq!((x0, x1), (0, 1), "z carried into the quiet run");
    assert_eq!(sz.row_flags & FLAG_RIGHT_EDGE, 0, "unknown value → edge suppressed");
    // Clean value but the next bucket touches x/z → suppressed too.
    let (s0, x0, x1) = seg(5);
    assert_eq!((x0, x1), (0, 0));
    assert_eq!(s0.row_flags & FLAG_RIGHT_EDGE, 0, "next bucket has x → suppressed");
    let (s2, _, _) = seg(25);
    assert_eq!(s2.row_flags & FLAG_RIGHT_EDGE, 0, "next bucket has z → suppressed");
    // Clean value, clean next bucket (0 at t=300) → edge drawn.
    let (s1, x0, x1) = seg(45);
    assert_eq!((x0, x1), (1, 0));
    assert_ne!(s1.row_flags & FLAG_RIGHT_EDGE, 0, "clean→clean keeps the edge");
}

#[test]
fn multi_bit_xz_bands_and_values() {
    let mut db = TraceDb::open(xz_vcd("xz_bus.vcd")).unwrap();
    let id = sig(&db, "top.bus");
    let pack = pack_row_buckets(&mut db, &spec(7, id, 4, Radix::Hex), 0, 300, 5).unwrap();
    assert_partition(&pack, 0, 300);
    for b in &pack.bands {
        assert!(b.multi, "4-bit row → multi bands");
        assert_eq!(b.row, 7);
    }
    let band_at = |t: u64| pack.bands.iter().find(|b| b.t_start == t).unwrap();
    assert!(band_at(100).has_x && !band_at(100).has_z, "xx01 at t=100");
    assert!(band_at(200).has_z && !band_at(200).has_x, "zz11 at t=200");

    // Quiet run [105,110) carries xx01 — bytes equal value_at, p1 nonzero.
    let i = pack.segments.iter().position(|s| s.t_start == 105).unwrap();
    let (p0, p1) = planes_at(&mut db, id, 107, 1);
    assert_eq!((pack.x0[i], pack.x1[i]), (p0[0], p1[0]));
    assert_ne!(pack.x1[i], 0, "x bits carried in the p1 plane");
    // Multi rows keep the right gap even next to an unknown band.
    assert_ne!(pack.segments[i].row_flags & FLAG_RIGHT_EDGE, 0);
    // The trailing quiet run [215, 300] has no next run → no right edge.
    let last = pack.segments.last().unwrap();
    assert_eq!((last.t_start, last.t_end), (215, 300));
    assert_eq!(last.row_flags & FLAG_RIGHT_EDGE, 0);
    assert_label_offsets(&pack, pack.segments.len());
}

#[test]
fn leading_quiet_run_without_initial_is_skipped() {
    let mut db = TraceDb::open(late_vcd("late.vcd")).unwrap();
    let id = sig(&db, "top.late");
    // Window starts at 0; the signal's first sample is at t=10 → initial()
    // None → the unknown leading quiet run emits nothing (documented choice).
    let pack = pack_row_buckets(&mut db, &spec(0, id, 1, Radix::Bin), 0, 100, 5).unwrap();
    let v = items(&pack);
    assert_eq!(v[0], (10, 15, true), "first item is the band at the first sample");
    assert!(v.iter().all(|&(s, _, _)| s >= 10), "nothing emitted before t=10");
    // From the first known boundary on, the partition is exact.
    assert_partition(&pack, 10, 100);
}

#[test]
fn period_one_degenerates_sanely_and_zero_clamps() {
    let mut db = TraceDb::open(dense_vcd("period1.vcd")).unwrap();
    let id = sig(&db, "top.cnt");
    let pack = pack_row_buckets(&mut db, &spec(0, id, 8, Radix::Hex), 500, 2500, 1).unwrap();
    assert_partition(&pack, 500, 2500);
    // Changes at 1000 and 2000 → single-tick bands between three quiet runs.
    assert_eq!(
        items(&pack),
        vec![
            (500, 1000, false),
            (1000, 1001, true),
            (1001, 2000, false),
            (2000, 2001, true),
            (2001, 2500, false),
        ]
    );
    // period == 0 clamps to 1.
    let pack0 = pack_row_buckets(&mut db, &spec(0, id, 8, Radix::Hex), 500, 2500, 0).unwrap();
    assert!(packs_eq(&pack, &pack0), "period 0 must behave as period 1");

    // A dense row at period 1: every bucket holds its one toggle → one band.
    let tgl = sig(&db, "top.tgl");
    let pack = pack_row_buckets(&mut db, &spec(0, tgl, 1, Radix::Bin), 0, 1000, 1).unwrap();
    assert!(pack.segments.is_empty());
    assert_eq!(items(&pack), vec![(0, 1000, true)]);
}

#[test]
fn empty_and_degenerate_windows() {
    let mut db = TraceDb::open(dense_vcd("empty.vcd")).unwrap();
    let id = sig(&db, "top.cnt");
    // Inverted window → empty pack with the canonical [0] offsets.
    let pack = pack_row_buckets(&mut db, &spec(0, id, 8, Radix::Hex), 50, 40, 16).unwrap();
    assert!(pack.segments.is_empty() && pack.bands.is_empty());
    assert!(pack.x0.is_empty() && pack.x1.is_empty());
    assert_eq!(pack.label_offsets, vec![0]);
    // Single-instant window inside a quiet span → one zero-width segment.
    let pack = pack_row_buckets(&mut db, &spec(0, id, 8, Radix::Hex), 500, 500, 16).unwrap();
    assert_eq!(items(&pack), vec![(500, 500, false)]);
}
