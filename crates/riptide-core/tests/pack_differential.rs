//! Differential tests: the Rust packer vs the Zig oracle.
//!
//! `fixtures/pack_oracle.json` is the dump of the production napi addon's
//! `getMockSegments` over `native/src/mock.vcd` (the exact packed-scene seam
//! the old renderer consumed) — regenerate with
//! `node crates/riptide-core/tests/gen_pack_oracle.cjs` (see that file).
//!
//! Ground rules (MIGRATION.md):
//! - Segment headers (t_start/t_end/row_flags), RowInfos and pool layout
//!   compare EXACTLY.
//! - Sample pools compare byte-equal where 2-state; where x/z appear they
//!   compare per-bit as DECODED states (the X/Z plane convention is swapped
//!   between the Zig db and tide.rs — packing copies planes verbatim, so raw
//!   bytes legitimately differ on unknown bits).
//! - Label BYTES are unit U3's (the seed `format_value` stub writes "?"), so
//!   labels compare STRUCTURALLY: offset-vec length, alignment with the
//!   segment streams, and the empty/non-empty pattern (muted ⇔ empty).

use riptide_core::pack::Packer;
use riptide_core::TraceDb;
use riptide_contract::spec::{ClockPolarity, EnumEntry, PackKind, Radix, RowSpec};

fn repo_path(rel: &str) -> std::path::PathBuf {
    std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../..").join(rel)
}

fn load_oracle() -> serde_json::Value {
    let text = std::fs::read_to_string(repo_path("crates/riptide-core/tests/fixtures/pack_oracle.json"))
        .expect("fixture missing — run gen_pack_oracle.cjs");
    serde_json::from_str(&text).unwrap()
}

fn open_mock() -> TraceDb {
    TraceDb::open(repo_path("native/src/mock.vcd")).expect("open mock.vcd")
}

fn radix_of(s: &str) -> Radix {
    match s {
        "hex" => Radix::Hex,
        "dec" => Radix::Dec,
        "sdec" => Radix::Sdec,
        "enum" => Radix::Enum,
        "boolean" => Radix::Boolean,
        _ => Radix::Bin,
    }
}

/// Resolves a fixture path to a tide handle, tolerating the range suffix.
///
/// The oracle fixture keys signals by their BARE path (the generator strips the
/// VCD range, e.g. `in_addr` for `in_addr[15:0]`), because the Zig hierarchy it
/// ran against exposed bare names. tide.rs keeps the range in the var name (the
/// canonical, sidecar-compatible form — see `mock.vcd.sidecar.json`), so a bare
/// path misses `db.find`. We therefore also accept a bare path by matching each
/// signal's range-stripped full path. The resolved signal — hence the packed
/// data — is identical either way; only the spelling of the lookup key differs.
fn handle_of(db: &TraceDb, path: &str) -> String {
    if let Some(id) = db.find(path) {
        return id.0.to_string();
    }
    use riptide_contract::hier::NodeDto;
    let dto = db.hierarchy_dto();
    let mut by_id = std::collections::HashMap::new();
    for n in &dto.nodes {
        let (id, parent, name) = match n {
            NodeDto::Scope { id, parent, name, .. } => (*id, *parent, name.as_str()),
            NodeDto::Signal { id, parent, name, .. } => (*id, *parent, name.as_str()),
        };
        by_id.insert(id, (parent, name));
    }
    let strip = |s: &str| s.split('[').next().unwrap_or(s).to_string();
    let full_path = |mut id: u32| -> String {
        let mut parts = Vec::new();
        while let Some(&(parent, name)) = by_id.get(&id) {
            parts.push(strip(name));
            match parent {
                Some(p) => id = p,
                None => break,
            }
        }
        parts.reverse();
        parts.join(".")
    };
    for n in &dto.nodes {
        if let NodeDto::Signal { id, handle, .. } = n
            && full_path(*id) == path
        {
            return handle.clone();
        }
    }
    panic!("no signal at {path}");
}

/// Builds the Rust `RowSpec`s for one fixture case (path → tide.rs handle).
fn specs_of(db: &TraceDb, case: &serde_json::Value) -> Vec<RowSpec> {
    case["specs"]
        .as_array()
        .unwrap()
        .iter()
        .map(|s| {
            let path = s["path"].as_str().unwrap().to_string();
            RowSpec {
                row: s["row"].as_u64().unwrap() as u32,
                handle: handle_of(db, &path),
                kind: match s["kind"].as_str().unwrap() {
                    "clk" => PackKind::Clk,
                    _ => PackKind::Data,
                },
                polarity: match s["polarity"].as_str().unwrap() {
                    "falling" => ClockPolarity::Falling,
                    "both" => ClockPolarity::Both,
                    _ => ClockPolarity::Rising,
                },
                shaded: s["shaded"].as_bool().unwrap(),
                mute_handle: s["mutePath"].as_str().map(|p| handle_of(db, p)),
                radix: radix_of(s["radix"].as_str().unwrap()),
                enums: s["enums"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|e| EnumEntry {
                        value: e["value"].as_u64().unwrap() as u32,
                        label: e["label"].as_str().unwrap().to_string(),
                    })
                    .collect(),
                path,
                color: 0,
                hidden: false,
                selected: false,
                height: None,
                divider_below: false,
                divider_height: None,
                bit_width: 0,
            }
        })
        .collect()
}

fn u32_vec(v: &serde_json::Value) -> Vec<u32> {
    v.as_array().unwrap().iter().map(|x| x.as_u64().unwrap() as u32).collect()
}

fn hex_bytes(v: &serde_json::Value) -> Vec<u8> {
    let s = v.as_str().unwrap();
    (0..s.len() / 2).map(|i| u8::from_str_radix(&s[2 * i..2 * i + 2], 16).unwrap()).collect()
}

/// Decodes one bit of a Zig-convention plane pair: (m,l) = (0,0) 0, (0,1) 1,
/// (1,0) x, (1,1) z.
fn zig_state(l: u8, m: u8) -> char {
    match (m, l) {
        (0, 0) => '0',
        (0, 1) => '1',
        (1, 0) => 'x',
        _ => 'z',
    }
}

/// Decodes one bit of a tide.rs-convention plane pair: X=(p0 1, p1 1),
/// Z=(p0 0, p1 1).
fn rs_state(p0: u8, p1: u8) -> char {
    match (p1, p0) {
        (0, 0) => '0',
        (0, 1) => '1',
        (1, 1) => 'x',
        _ => 'z',
    }
}

fn bit(bytes: &[u8], i: usize) -> u8 {
    (bytes[i / 8] >> (i % 8)) & 1
}

/// One pipeline's segment stream as `[t_start, t_end, row_flags]` triples.
fn seg_triples(segs: &[riptide_contract::gpu::PackedSegment]) -> Vec<[u32; 3]> {
    segs.iter().map(|s| [s.t_start, s.t_end, s.row_flags]).collect()
}

fn oracle_triples(v: &serde_json::Value) -> Vec<[u32; 3]> {
    v.as_array()
        .unwrap()
        .iter()
        .map(|t| {
            let t = u32_vec(t);
            [t[0], t[1], t[2]]
        })
        .collect()
}

/// The Zig scene emits a fully empty label stream as `[]`; the contract pins
/// `[0]` (count+1 prefix offsets). Normalize before structural comparison.
fn norm_offsets(mut v: Vec<u32>) -> Vec<u32> {
    if v.is_empty() {
        v.push(0);
    }
    v
}

/// Structural label-offset check: same entry count as the oracle and the same
/// empty/non-empty pattern per segment (muted segments carry an EMPTY label on
/// both sides; non-muted labeled segments are non-empty on both — the bytes
/// themselves are U3's and differ while `format_value` is the seed stub).
fn assert_label_structure(name: &str, stream: &str, got: &[u32], oracle: &[u32], seg_count: usize) {
    assert!(!got.is_empty(), "{name}/{stream}: offsets vec may not be empty");
    assert_eq!(got.len(), oracle.len(), "{name}/{stream}: offset count");
    assert_eq!(got.len(), seg_count + 1, "{name}/{stream}: count+1 prefix offsets");
    assert_eq!(got[0], 0, "{name}/{stream}: first offset");
    for i in 0..seg_count {
        assert!(got[i + 1] >= got[i], "{name}/{stream}: offsets monotonic at {i}");
        let got_empty = got[i + 1] == got[i];
        let oracle_empty = oracle[i + 1] == oracle[i];
        assert_eq!(
            got_empty, oracle_empty,
            "{name}/{stream}: label {i} emptiness (muted/unlabeled pattern)"
        );
    }
}

#[test]
fn pack_matches_zig_oracle() {
    let oracle = load_oracle();
    let mut db = open_mock();

    for case in oracle["cases"].as_array().unwrap() {
        let name = case["name"].as_str().unwrap();
        let q_start = case["qStart"].as_u64().unwrap();
        let q_end = case["qEnd"].as_u64().unwrap();
        let specs = specs_of(&db, case);
        let expect = &case["expect"];

        let mut packer = Packer::new();
        let out = packer.pack(&mut db, &specs, q_start, q_end).expect("pack");

        // Segment headers: timing + row/flag bits, exact.
        assert_eq!(seg_triples(&out.multi), oracle_triples(&expect["multi"]), "{name}: multi");
        assert_eq!(seg_triples(&out.single), oracle_triples(&expect["single"]), "{name}: single");

        // RowInfos: 7×u32, exact (byte offsets, stride, segment_start, zeroed
        // render fields).
        let got_infos: Vec<Vec<u32>> = out
            .row_infos
            .iter()
            .map(|r| {
                vec![r.x0_offset, r.x1_offset, r.bytes_per_sample, r.segment_start, r.flags, r.y_offset, r.height]
            })
            .collect();
        let want_infos: Vec<Vec<u32>> =
            expect["rowInfos"].as_array().unwrap().iter().map(u32_vec).collect();
        assert_eq!(got_infos, want_infos, "{name}: rowInfos");

        // Pools: identical layout (incl. the 4-byte tail pad)…
        let want_x0 = hex_bytes(&expect["x0Pool"]);
        let want_x1 = hex_bytes(&expect["x1Pool"]);
        assert_eq!(out.x0_pool.len(), want_x0.len(), "{name}: x0 pool size");
        assert_eq!(out.x1_pool.len(), want_x1.len(), "{name}: x1 pool size");

        // …and per-row, per-sample, per-bit decoded-state equality. Where a
        // sample is 2-state on both sides this degenerates to byte equality;
        // where x/z appear the conventions legitimately differ on raw bytes.
        let seg_count_of = |row: u32| -> usize {
            out.multi
                .iter()
                .chain(out.single.iter())
                .filter(|s| s.row_flags & 0xffff == row)
                .count()
        };
        for (row, info) in out.row_infos.iter().enumerate() {
            if info.bytes_per_sample == 0 {
                continue; // gap row
            }
            let bps = info.bytes_per_sample as usize;
            let count = seg_count_of(row as u32);
            for s in 0..count {
                let at = |pool: &[u8], off: u32| -> Vec<u8> {
                    pool[off as usize + s * bps..off as usize + (s + 1) * bps].to_vec()
                };
                let g0 = at(&out.x0_pool, info.x0_offset);
                let g1 = at(&out.x1_pool, info.x1_offset);
                let w0 = at(&want_x0, info.x0_offset);
                let w1 = at(&want_x1, info.x1_offset);
                let got: String = (0..bps * 8).map(|i| rs_state(bit(&g0, i), bit(&g1, i))).collect();
                let want: String = (0..bps * 8).map(|i| zig_state(bit(&w0, i), bit(&w1, i))).collect();
                assert_eq!(got, want, "{name}: row {row} sample {s} decoded states");
                // 2-state samples must be byte-equal (plane conventions agree).
                if w1.iter().all(|&b| b == 0) {
                    assert_eq!((g0, g1), (w0, w1), "{name}: row {row} sample {s} 2-state bytes");
                }
            }
        }

        // Labels: structure only (see module docs).
        assert_label_structure(
            name,
            "multi",
            &out.multi_label_offsets,
            &norm_offsets(u32_vec(&expect["multiLabelOffsets"])),
            out.multi.len(),
        );
        assert_label_structure(
            name,
            "single",
            &out.single_label_offsets,
            &norm_offsets(u32_vec(&expect["singleLabelOffsets"])),
            out.single.len(),
        );

        assert_eq!(out.end_ticks, expect["endTicks"].as_u64().unwrap(), "{name}: endTicks");
    }
}

/// Bin (unlabeled) single rows must still carry one EMPTY label entry per
/// segment, and boolean rows a non-empty one — checked against the oracle in
/// the main test; this pins the invariant standalone for the empty case.
#[test]
fn empty_specs_pack_empty_scene() {
    let mut db = open_mock();
    let mut packer = Packer::new();
    let out = packer.pack(&mut db, &[], 0, 90).unwrap();
    assert!(out.multi.is_empty());
    assert!(out.single.is_empty());
    assert!(out.row_infos.is_empty());
    assert!(out.x0_pool.is_empty());
    assert!(out.x1_pool.is_empty());
    assert_eq!(out.multi_label_offsets, vec![0]);
    assert_eq!(out.single_label_offsets, vec![0]);
    assert_eq!(out.end_ticks, 90);
}
