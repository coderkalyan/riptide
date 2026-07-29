//! Seam A: tide's own values against the oracle corpus, in process.
//!
//! For each fixture this loads the VCD straight through tide, resolves each
//! oracle path to a signal, and asserts the value active at every sampled tick
//! decodes to the oracle's bits. No Node, no Node-API — a divergence here is a
//! core bug, so a clean pass plus a clean differential (seam B) localizes any
//! value bug to the boundary.
//!
//! ```text
//! cargo test -p riptide-native --test oracle
//! VCD_TESTS_DIR=/path cargo test -p riptide-native --test oracle
//! ```
//!
//! The corpus is external, so an absent one skips rather than fails.

use std::path::{Path, PathBuf};

use riptide::pack::with_value_at;
use riptide::trace;
use serde_json::Value;
use tide_core::Sample;
use tide_core::metadata::Width;

/// Deterministic corpus. Add a name here when a new oracle lands.
const FIXTURES: &[&str] = &[
    "act_burst_idle",
    "bit_order",
    "feat_aliases",
    "feat_dumpoff_on",
    "feat_id_charset",
    "feat_var_types",
    "hier_balanced_soc",
    "hier_deep_narrow",
    "hier_flat_wide",
    "hier_many_scopes",
    "scale_medium",
    "scale_small",
    "sig_constants",
    "sig_enum_radix",
    "sig_real",
    "sig_widths",
    "sig_xz",
    "smoke_basic",
    "stress_many_active",
    "stress_wide_fast",
    "time_fs_timescale",
    "time_glitches",
    "time_long_dense_clk",
    "time_multiclock",
];

/// Variable types with no bits to compare. A real carries an f64 tide cannot
/// store, and an event is an occurrence rather than a value, so tide lists
/// neither in a form this test can check.
fn unchecked(kind: &str) -> bool {
    matches!(kind, "real" | "event")
}

fn corpus() -> Option<PathBuf> {
    let root = match std::env::var_os("VCD_TESTS_DIR") {
        Some(dir) => PathBuf::from(dir),
        None => PathBuf::from(std::env::var_os("HOME")?).join("Documents/vcd-tests"),
    };
    root.is_dir().then_some(root)
}
/// Four-state decode of a sample, most significant bit first, in the oracle's
/// spelling. The bounds disagree exactly on an unknown bit, and the `z` plane
/// then says which unknown it is.
fn decode_bits(sample: Sample<'_>, width: Width) -> String {
    let bit_of = |plane: &[u8], bit: u32| {
        plane
            .get((bit >> 3) as usize)
            .map_or(0, |b| (b >> (bit & 7)) & 1)
    };
    (0..width)
        .rev()
        .map(|bit| {
            let (low, high) = (bit_of(sample.min, bit), bit_of(sample.max, bit));
            match (low ^ high, low, bit_of(sample.z, bit)) {
                (0, 0, _) => '0',
                (0, _, _) => '1',
                (_, _, 0) => 'x',
                _ => 'z',
            }
        })
        .collect()
}

/// Whether an oracle `raw` is a four-state value at all. A real's raw is a
/// decimal like `8.333`, which no bit decode can match.
fn is_bit_string(text: &str) -> bool {
    !text.is_empty()
        && text
            .chars()
            .all(|c| matches!(c, '0' | '1' | 'x' | 'z' | 'X' | 'Z'))
}

#[derive(Default)]
struct Tally {
    checked: usize,
    skipped: usize,
    failures: Vec<String>,
}

#[test]
fn values_match_the_oracle() {
    let Some(root) = corpus() else {
        eprintln!("seam A skipped: no corpus (set VCD_TESTS_DIR)");
        return;
    };

    let mut tally = Tally::default();
    for name in FIXTURES {
        check_fixture(&root, name, &mut tally);
    }

    eprintln!(
        "\n── seam A (tide direct) ──\n  samples checked: {}\n  samples skipped (real/event/non-bit): {}\n  failures: {}\n",
        tally.checked,
        tally.skipped,
        tally.failures.len(),
    );
    for failure in tally.failures.iter().take(40) {
        eprintln!("  {failure}");
    }
    assert!(
        tally.failures.is_empty(),
        "{} divergences",
        tally.failures.len()
    );
}

fn check_fixture(root: &Path, name: &str, tally: &mut Tally) {
    let oracle_path = root.join(format!("oracle/{name}.json"));
    let vcd_path = root.join(format!("fixtures/{name}.vcd"));

    let oracle: Value = match std::fs::read(&oracle_path) {
        Ok(bytes) => serde_json::from_slice(&bytes).expect("oracle is valid json"),
        Err(error) => {
            tally.failures.push(format!(
                "{name}: cannot read {}: {error}",
                oracle_path.display()
            ));
            return;
        }
    };

    let loaded = match trace::open(&vcd_path) {
        Ok(loaded) => loaded,
        Err(error) => {
            tally.failures.push(format!("{name}: {error}"));
            return;
        }
    };
    let hierarchy = &loaded.trace.hierarchy;

    for entry in oracle["hierarchy"].as_array().into_iter().flatten() {
        let path = entry["path"].as_str().expect("hierarchy path");
        if unchecked(entry["type"].as_str().unwrap_or("")) && hierarchy.find(path).is_none() {
            // An event var is not representable, so tide leaves it out entirely.
            tally.skipped += 1;
            continue;
        }
        let Some(var) = hierarchy.find(path).map(|id| hierarchy.var(id)) else {
            tally
                .failures
                .push(format!("{name}: hierarchy missing {path}"));
            continue;
        };
        let expected = entry["width"].as_u64().expect("hierarchy width") as Width;
        if var.ty.width() != expected {
            tally.failures.push(format!(
                "{name}: {path} width {} != oracle {expected}",
                var.ty.width(),
            ));
        }
    }

    for case in oracle["cases"].as_array().into_iter().flatten() {
        let case_name = case["name"].as_str().unwrap_or("?");
        let Some(signals) = case["signals"].as_object() else {
            continue;
        };
        for (path, signal) in signals {
            if unchecked(signal["type"].as_str().unwrap_or("")) {
                tally.skipped += 1;
                continue;
            }
            let Some(var) = hierarchy.find(path).map(|id| hierarchy.var(id)) else {
                tally
                    .failures
                    .push(format!("{name}/{case_name}: unresolved {path}"));
                continue;
            };
            let (Some(id), width) = (var.signal, var.ty.width()) else {
                tally
                    .failures
                    .push(format!("{name}/{case_name}: {path} has no signal"));
                continue;
            };

            for sample in signal["samples"].as_array().into_iter().flatten() {
                let (Some(raw), Some(at)) = (sample["raw"].as_str(), sample["t"].as_str()) else {
                    tally.skipped += 1;
                    continue;
                };
                let Ok(at) = at.parse() else {
                    tally.skipped += 1;
                    continue;
                };
                if !is_bit_string(raw) {
                    tally.skipped += 1;
                    continue;
                }

                let bits = with_value_at(&loaded.trace.db, id, at, |sample, _| {
                    decode_bits(sample, width)
                });
                match bits {
                    Some(bits) if bits == raw => tally.checked += 1,
                    Some(bits) => tally.failures.push(format!(
                        "{name}/{case_name}: {path}@{at} = {bits} != oracle {raw}",
                    )),
                    None => tally
                        .failures
                        .push(format!("{name}/{case_name}: {path}@{at} has no value")),
                }
            }
        }
    }
}
