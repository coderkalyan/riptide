//! Pack-cache behavior: the `PackKey`(+window) cache must make an
//! add/remove/reorder/radix-change repack ONLY the changed signal (the rest
//! replay from cache — no tide query, no flag walk, no label format).
//! Observed via `Packer::fresh_packs` (fresh per-signal packs performed) and
//! `Packer::contains`.

use riptide_contract::pack::PackKey;
use riptide_contract::spec::{ClockPolarity, PackKind, Radix, RowSpec};
use riptide_core::TraceDb;
use riptide_core::pack::Packer;

fn open_mock() -> TraceDb {
    let p = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../native/src/mock.vcd");
    TraceDb::open(p).expect("open mock.vcd")
}

fn spec(db: &TraceDb, row: u32, path: &str, radix: Radix) -> RowSpec {
    RowSpec {
        row,
        handle: db.find(path).unwrap().0.to_string(),
        path: path.to_string(),
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
        bit_width: 0,
    }
}

#[test]
fn same_key_and_window_reuses_cache() {
    let mut db = open_mock();
    let mut packer = Packer::new();
    let specs = vec![
        spec(&db, 0, "top.keysched.waves.in_addr", Radix::Hex),
        spec(&db, 1, "top.keysched.rst_n", Radix::Bin),
    ];

    let first = packer.pack(&mut db, &specs, 0, 90).unwrap();
    assert_eq!(packer.fresh_packs(), 2);
    assert!(packer.contains(&PackKey::of(&specs[0]), 0, 90));

    // Identical repack: zero fresh packs, identical output.
    let second = packer.pack(&mut db, &specs, 0, 90).unwrap();
    assert_eq!(packer.fresh_packs(), 2, "same key+window must not re-query");
    assert_eq!(first, second);
}

#[test]
fn radix_change_repacks_only_the_changed_signal() {
    let mut db = open_mock();
    let mut packer = Packer::new();
    let mut specs = vec![
        spec(&db, 0, "top.keysched.waves.in_addr", Radix::Hex),
        spec(&db, 1, "top.keysched.waves.cycle_count", Radix::Hex),
    ];
    packer.pack(&mut db, &specs, 0, 90).unwrap();
    assert_eq!(packer.fresh_packs(), 2);

    let old_key = PackKey::of(&specs[1]);
    specs[1].radix = Radix::Dec;
    packer.pack(&mut db, &specs, 0, 90).unwrap();
    assert_eq!(packer.fresh_packs(), 3, "only the radix-changed row repacks");
    // The stale-radix entry stays cached (same window) — a toggle back is free.
    assert!(packer.contains(&old_key, 0, 90));
    packer.pack(&mut db, &[specs[0].clone()], 0, 90).unwrap();
    assert_eq!(packer.fresh_packs(), 3, "a removed row costs nothing");
}

#[test]
fn reorder_and_move_replay_from_cache() {
    let mut db = open_mock();
    let mut packer = Packer::new();
    let a = spec(&db, 0, "top.keysched.waves.in_addr", Radix::Hex);
    let b = spec(&db, 1, "top.keysched.waves.dbus", Radix::Hex);
    let out1 = packer.pack(&mut db, &[a.clone(), b.clone()], 0, 90).unwrap();
    assert_eq!(packer.fresh_packs(), 2);

    // Swap rows: no fresh packs; the same segments come back with the row
    // bits (and row-derived layout) swapped.
    let mut a2 = a.clone();
    a2.row = 1;
    let mut b2 = b.clone();
    b2.row = 0;
    let out2 = packer.pack(&mut db, &[b2, a2], 0, 90).unwrap();
    assert_eq!(packer.fresh_packs(), 2, "reorder must not re-query");
    assert_eq!(out1.multi.len(), out2.multi.len());
    let rows1: Vec<u32> = out1.multi.iter().map(|s| s.row_flags & 0xffff).collect();
    let rows2: Vec<u32> = out2.multi.iter().map(|s| s.row_flags & 0xffff).collect();
    assert!(rows1.iter().any(|&r| r == 0) && rows1.iter().any(|&r| r == 1));
    assert!(rows2.iter().any(|&r| r == 0) && rows2.iter().any(|&r| r == 1));
    // Flag bits (sans row) are untouched by placement.
    let flags = |segs: &[riptide_contract::gpu::PackedSegment]| -> Vec<u32> {
        let mut v: Vec<u32> = segs.iter().map(|s| s.row_flags & !0xffffu32).collect();
        v.sort_unstable();
        v
    };
    assert_eq!(flags(&out1.multi), flags(&out2.multi));
}

#[test]
fn window_change_evicts_and_repacks() {
    let mut db = open_mock();
    let mut packer = Packer::new();
    let specs = vec![spec(&db, 0, "top.keysched.waves.in_addr", Radix::Hex)];
    let key = PackKey::of(&specs[0]);

    packer.pack(&mut db, &specs, 0, 90).unwrap();
    assert_eq!(packer.fresh_packs(), 1);
    assert!(packer.contains(&key, 0, 90));
    assert!(!packer.contains(&key, 30, 60), "different window must miss");

    packer.pack(&mut db, &specs, 30, 60).unwrap();
    assert_eq!(packer.fresh_packs(), 2, "window change repacks");
    assert!(packer.contains(&key, 30, 60));
    assert!(!packer.contains(&key, 0, 90), "stale-window entry evicted");
}

#[test]
fn clear_drops_everything() {
    let mut db = open_mock();
    let mut packer = Packer::new();
    let specs = vec![spec(&db, 0, "top.keysched.waves.in_addr", Radix::Hex)];
    let key = PackKey::of(&specs[0]);
    packer.pack(&mut db, &specs, 0, 90).unwrap();
    assert!(packer.contains(&key, 0, 90));
    packer.clear();
    assert!(!packer.contains(&key, 0, 90));
    packer.pack(&mut db, &specs, 0, 90).unwrap();
    assert_eq!(packer.fresh_packs(), 2);
}

#[test]
fn duplicate_rows_share_one_pack() {
    let mut db = open_mock();
    let mut packer = Packer::new();
    let a = spec(&db, 0, "top.keysched.waves.in_addr", Radix::Hex);
    let mut b = a.clone();
    b.row = 1; // same signal+config at a second row — one cache entry
    let out = packer.pack(&mut db, &[a, b], 0, 90).unwrap();
    assert_eq!(packer.fresh_packs(), 1);
    assert_eq!(out.row_infos.len(), 2);
    assert!(out.row_infos.iter().all(|r| r.bytes_per_sample == 2));
}

#[test]
fn unknown_handle_errors() {
    let mut db = open_mock();
    let mut packer = Packer::new();
    let mut s = spec(&db, 0, "top.keysched.waves.in_addr", Radix::Hex);
    s.handle = "not-a-handle".into();
    assert!(packer.pack(&mut db, &[s], 0, 90).is_err());
}

/// An unresolvable mute handle falls back to the unmuted walk (matches the
/// Zig parseSpec/packSignal behavior) rather than erroring.
#[test]
fn unresolvable_mute_falls_back_unmuted() {
    let mut db = open_mock();
    let mut packer = Packer::new();
    let plain = spec(&db, 0, "top.keysched.waves.in_addr", Radix::Hex);
    let mut muted = plain.clone();
    muted.mute_handle = Some("99999".into()); // parses, but no such signal
    let out_muted = packer.pack(&mut db, &[muted], 0, 90).unwrap();
    let mut p2 = Packer::new();
    let out_plain = p2.pack(&mut db, &[plain], 0, 90).unwrap();
    assert_eq!(out_muted.multi, out_plain.multi);
    assert_eq!(out_muted.x0_pool, out_plain.x0_pool);
}
