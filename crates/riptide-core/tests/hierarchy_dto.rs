//! Differential test: `TraceDb::hierarchy_dto` vs the old Zig addon's
//! `getHierarchy()` on the bundled mock VCD.
//!
//! The fixture (`tests/fixtures/zig_hierarchy_mock.json`) is a verbatim dump
//! of the Zig oracle — regenerate with `pnpm build:native && node
//! scripts/dump-hier.cjs`. The comparison is a full deep-equal of the JSON
//! (key-order-insensitive via `serde_json::Value`) after two normalizations:
//!
//! - numbers compare as f64 (the DTO carries `endTicks` as f64; the oracle
//!   serialized it as an integer);
//! - signal handles: the Zig symbol table minted 1-based ids (0 was the
//!   `.null` sentinel) while tide.rs mints 0-based dense ids — both in $var
//!   first-sight order, so `handle_rust = handle_zig - 1` exactly. The
//!   fixture's handles are shifted down before comparing, which still pins
//!   the var→signal binding order one-to-one.

use std::path::Path;

use serde_json::Value;

fn normalize_numbers(v: Value) -> Value {
    match v {
        Value::Number(n) => {
            let f = n.as_f64().expect("fixture numbers fit f64");
            serde_json::json!(f)
        }
        Value::Array(a) => Value::Array(a.into_iter().map(normalize_numbers).collect()),
        Value::Object(o) => {
            Value::Object(o.into_iter().map(|(k, v)| (k, normalize_numbers(v))).collect())
        }
        other => other,
    }
}

/// Shifts every signal node's decimal `handle` down by one (Zig 1-based →
/// tide.rs 0-based).
fn shift_handles(mut v: Value) -> Value {
    let nodes = v["nodes"].as_array_mut().expect("oracle has nodes");
    for node in nodes {
        if node["kind"] == "signal" {
            let h: u64 = node["handle"]
                .as_str()
                .expect("handle is a decimal string")
                .parse()
                .expect("handle parses as u64");
            assert!(h >= 1, "Zig handles are 1-based");
            node["handle"] = Value::String((h - 1).to_string());
        }
    }
    v
}

#[test]
fn hierarchy_dto_matches_zig_oracle_on_mock_vcd() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR"));
    let vcd = root.join("../../native/src/mock.vcd");
    let fixture = root.join("tests/fixtures/zig_hierarchy_mock.json");

    let db = riptide_core::TraceDb::open(&vcd).expect("mock.vcd opens");
    let got = normalize_numbers(serde_json::to_value(db.hierarchy_dto()).expect("dto serializes"));

    let oracle: Value =
        serde_json::from_str(&std::fs::read_to_string(&fixture).expect("fixture readable"))
            .expect("fixture is JSON");
    let want = normalize_numbers(shift_handles(oracle));

    // Spot-check the shape first so a mismatch fails with a readable message
    // before the full deep-equal.
    assert_eq!(got["rootIds"], want["rootIds"], "root ids");
    assert_eq!(
        got["nodes"].as_array().unwrap().len(),
        want["nodes"].as_array().unwrap().len(),
        "node count"
    );
    for (g, w) in got["nodes"]
        .as_array()
        .unwrap()
        .iter()
        .zip(want["nodes"].as_array().unwrap())
    {
        assert_eq!(g, w, "node {} ({})", w["id"], w["name"]);
    }
    assert_eq!(got["timescale"], want["timescale"], "timescale");
    assert_eq!(got["endTicks"], want["endTicks"], "endTicks");
    assert_eq!(got, want, "full hierarchy DTO");
}

/// The DTO walk drops nothing: every var and every non-root scope of the
/// tide hierarchy appears exactly once.
#[test]
fn hierarchy_dto_covers_every_scope_and_var() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR"));
    let db = riptide_core::TraceDb::open(root.join("../../native/src/mock.vcd")).unwrap();
    let dto = db.hierarchy_dto();
    let h = db.waves().hierarchy();

    let scopes = dto
        .nodes
        .iter()
        .filter(|n| matches!(n, riptide_contract::hier::NodeDto::Scope { .. }))
        .count();
    let signals = dto.nodes.len() - scopes;
    assert_eq!(scopes, h.scope_count() - 1, "all non-root scopes emitted");
    assert_eq!(signals, h.var_count(), "all vars emitted");
}
