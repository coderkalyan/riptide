//! Clock-grid detection + reset-band spans — port of
//! `src/renderer/wave/clock.ts` on top of `TraceDb::edges`.
//!
//! OWNED BY UNIT U5. The two functions below are cross-unit surfaces (U10
//! calls `detect_clock_grid` on timebase changes).
//!
//! Plane convention (tide.rs, NOT the Zig db): a bit is unknown (x/z) when its
//! p1 bit is set; otherwise p0 is the logic level. `LogicSlice::proj4(0)`
//! gives bit 0's 4-state projection straight from planes 0–1.

use riptide_contract::spec::{ClockGrid, ClockPolarity};
use tide::{LogicSlice, SignalId, State};

use crate::TraceDb;

/// Transitions to sample for clock detection. A clock toggles twice per cycle,
/// so 32 transitions give ~16 cycles — plenty for a stable median while
/// staying a tiny prefix read (`clock.ts CLOCK_SAMPLE`).
const CLOCK_SAMPLE: u32 = 32;
/// Transitions to pull per `edges` call while walking a reset's visible window
/// (`clock.ts RESET_CHUNK`).
const RESET_CHUNK: u32 = 64;

/// `clock.ts median` — middle element, or the mean of the middle two.
fn median(xs: &[f64]) -> f64 {
    let mut s = xs.to_vec();
    s.sort_by(|a, b| a.partial_cmp(b).expect("intervals are finite"));
    let m = s.len() >> 1;
    if s.len() % 2 == 1 { s[m] } else { (s[m - 1] + s[m]) / 2.0 }
}

/// Bit 0's decoded level, if defined. `None` for x/z (p1 set), empty-width
/// samples, and real signals' (absent) logic plane.
fn level_of(v: &LogicSlice<'_>) -> Option<bool> {
    if v.width() == 0 {
        return None;
    }
    match v.proj4(0) {
        State::Zero => Some(false),
        State::One => Some(true),
        _ => None, // X / Z — never an edge, never "high"
    }
}

/// A transition is "active" for a given polarity when its decoded logic level
/// is the reference level: 1 for rising, 0 for falling; `Both` is treated as
/// rising. x/z are never edges (`clock.ts isRefEdge`).
fn is_ref_edge(v: &LogicSlice<'_>, polarity: ClockPolarity) -> bool {
    match level_of(v) {
        Some(level) => {
            if polarity == ClockPolarity::Falling { !level } else { level }
        }
        None => false,
    }
}

/// A 1-bit signal is "high" when its decoded logic level is 1 (x/z never
/// counts as high) (`clock.ts isHigh`).
fn is_high(v: &LogicSlice<'_>) -> bool {
    level_of(v) == Some(true)
}

/// Detects the timebase grid (period/phase) from a clock signal's edge prefix
/// (median-of-deltas check, mirrors `wave/clock.ts detectClockGrid`):
/// phase = first reference-edge tick; period = median edge-to-edge interval;
/// valid = at least two edges and all intervals within ±25% of the median (a
/// crude regularity check so a gated/irregular head is flagged, not trusted).
///
/// Returns `None` only when the signal id doesn't resolve or the query fails
/// (the TS returned `{0, 1, false}` for a null native result; callers treat
/// both as "no grid").
pub fn detect_clock_grid(
    db: &mut TraceDb,
    id: SignalId,
    polarity: ClockPolarity,
) -> Option<ClockGrid> {
    let q = db.edges(id, 0, CLOCK_SAMPLE).ok()??;
    let mut total: u64 = 0;
    let mut edges: Vec<u64> = Vec::new();
    for (t, v) in q.samples() {
        total += 1;
        if is_ref_edge(&v, polarity) {
            edges.push(t);
        }
    }
    if total < 2 {
        return Some(ClockGrid { phase: 0.0, period: 1.0, valid: false });
    }
    if edges.len() < 2 {
        let phase = edges.first().copied().unwrap_or(0) as f64;
        return Some(ClockGrid { phase, period: 1.0, valid: false });
    }
    let intervals: Vec<f64> =
        edges.windows(2).map(|w| (w[1] - w[0]) as f64).collect();
    let period = median(&intervals);
    let valid = period > 0.0
        && intervals.iter().all(|d| (d - period).abs() <= period * 0.25);
    Some(ClockGrid {
        phase: edges[0] as f64,
        period: if period > 0.0 { period } else { 1.0 },
        valid,
    })
}

/// The intervals where a reset signal is held HIGH within `[start, end]`,
/// clamped to the window (mirrors `wave/clock.ts resetHighSpans`). Drives the
/// bottom-ruler crosshatch bands. Cost is O(visible transitions): one
/// `value_at` for the level entering the window, then paginated `edges` reads
/// across it — never a whole-trace scan. An active-low reset simply yields no
/// high spans. Empty when the signal is unknown or the window is empty.
pub fn reset_high_spans(
    db: &mut TraceDb,
    id: SignalId,
    start: u64,
    end: u64,
) -> Vec<(u64, u64)> {
    if end <= start {
        return Vec::new();
    }
    let mut spans: Vec<(u64, u64)> = Vec::new();
    // Level entering the window: value_at reflects any transition exactly at
    // `start`, so the matching sample in the walk below is skipped
    // (hi == high) — no double count.
    let mut high = match db.value_at(&[id], start) {
        Ok(vals) => vals
            .first()
            .and_then(|v| v.as_ref())
            .and_then(|s| s.value.logic())
            .is_some_and(|v| is_high(&v)),
        Err(_) => false,
    };
    let mut open: Option<u64> = if high { Some(start) } else { None };
    let mut cursor = start;
    while let Ok(Some(q)) = db.edges(id, cursor, RESET_CHUNK) {
        let n = q.len();
        if n == 0 {
            break;
        }
        let mut past = false;
        let mut last_t = cursor;
        for (t, v) in q.samples() {
            last_t = t;
            if t > end {
                past = true;
                break;
            }
            let hi = is_high(&v);
            if hi == high {
                // Not a level change. Also absorbs tide's covering-set re-read:
                // `edges` starts at the covering sample at-or-before `cursor`
                // (the previous chunk's last sample), unlike the old Zig
                // at/after read — same filter, no double count.
                continue;
            }
            high = hi;
            if hi {
                open = Some(t);
            } else if let Some(o) = open.take() {
                spans.push((o, t));
            }
        }
        if past || n < RESET_CHUNK as u64 {
            break;
        }
        cursor = last_t + 1; // ticks are distinct integers — strict progress
    }
    if let Some(o) = open {
        spans.push((o, end)); // still high at window end
    }
    spans
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A VCD with a 10-tick clock (rising edges 5,15,…,85) and a reset held
    /// high over [0,15) and [40,60). `$version`/`$timescale`/`$dumpvars` are
    /// all required by the parser.
    const VCD: &str = "\
$version test $end
$timescale 1ns $end
$scope module top $end
$var wire 1 ! clk $end
$var wire 1 \" rst $end
$var wire 1 # irr $end
$upscope $end
$enddefinitions $end
$dumpvars
0!
1\"
0#
$end
#5
1!
#10
0!
1#
#15
1!
0\"
#17
0#
#20
0!
#25
1!
#30
0!
#35
1!
#40
0!
1\"
#45
1!
#50
0!
#55
1!
#60
0!
0\"
#65
1!
#70
0!
#75
1!
#80
0!
#85
1!
#90
0!
";

    fn open_vcd() -> (TraceDb, std::path::PathBuf) {
        let path = std::env::temp_dir().join(format!(
            "riptide-u5-clock-{}-{:?}.vcd",
            std::process::id(),
            std::thread::current().id(),
        ));
        std::fs::write(&path, VCD).unwrap();
        (TraceDb::open(&path).unwrap(), path)
    }

    #[test]
    fn detects_clock_grid() {
        let (mut db, path) = open_vcd();
        let clk = db.find("top.clk").unwrap();
        let g = detect_clock_grid(&mut db, clk, ClockPolarity::Rising).unwrap();
        assert!(g.valid);
        assert_eq!(g.phase, 5.0);
        assert_eq!(g.period, 10.0);
        // Falling polarity: first 0-level transition is the initial dump at 0,
        // then 10,20,… — phase 0, period 10, still regular.
        let g = detect_clock_grid(&mut db, clk, ClockPolarity::Falling).unwrap();
        assert!(g.valid);
        assert_eq!(g.phase, 0.0);
        assert_eq!(g.period, 10.0);
        // Both behaves as rising.
        let g = detect_clock_grid(&mut db, clk, ClockPolarity::Both).unwrap();
        assert_eq!((g.phase, g.period, g.valid), (5.0, 10.0, true));
        std::fs::remove_file(path).ok();
    }

    #[test]
    fn irregular_clock_is_invalid() {
        let (mut db, path) = open_vcd();
        // irr rises at 10 only (one ref edge) → period 1, invalid.
        let irr = db.find("top.irr").unwrap();
        let g = detect_clock_grid(&mut db, irr, ClockPolarity::Rising).unwrap();
        assert!(!g.valid);
        assert_eq!(g.phase, 10.0);
        assert_eq!(g.period, 1.0);
        std::fs::remove_file(path).ok();
    }

    #[test]
    fn reset_spans_full_window() {
        let (mut db, path) = open_vcd();
        let rst = db.find("top.rst").unwrap();
        // High at dump (0) → falls at 15; rises at 40 → falls at 60.
        assert_eq!(reset_high_spans(&mut db, rst, 0, 90), vec![(0, 15), (40, 60)]);
        std::fs::remove_file(path).ok();
    }

    #[test]
    fn reset_spans_clamped_window() {
        let (mut db, path) = open_vcd();
        let rst = db.find("top.rst").unwrap();
        // Window opens mid-high (value_at(10) = 1) and closes mid-high.
        assert_eq!(reset_high_spans(&mut db, rst, 10, 45), vec![(10, 15), (40, 45)]);
        // Window entirely inside a low stretch.
        assert_eq!(reset_high_spans(&mut db, rst, 20, 35), vec![]);
        // Window starting exactly on the falling edge at 15: value_at(15)
        // reflects the transition (low), no span until 40.
        assert_eq!(reset_high_spans(&mut db, rst, 15, 50), vec![(40, 50)]);
        // Empty window.
        assert_eq!(reset_high_spans(&mut db, rst, 30, 30), vec![]);
        std::fs::remove_file(path).ok();
    }
}
