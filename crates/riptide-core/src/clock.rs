//! Clock-grid detection + reset-band spans — port of
//! `src/renderer/wave/clock.ts` on top of `TraceDb::edges`.
//!
//! OWNED BY UNIT U5. The two functions below are cross-unit surfaces (U10
//! calls `detect_clock_grid` on timebase changes); seed stubs return None/empty
//! (non-panicking) until U5 merges.

use riptide_contract::spec::{ClockGrid, ClockPolarity};
use tide::SignalId;

use crate::TraceDb;

/// Detects the timebase grid (period/phase) from a clock signal's edge prefix
/// (median-of-deltas check, mirrors `wave/clock.ts detectClockGrid`).
pub fn detect_clock_grid(
    _db: &mut TraceDb,
    _id: SignalId,
    _polarity: ClockPolarity,
) -> Option<ClockGrid> {
    // U5: port detectClockGrid (paginated getEdges walk).
    None
}

/// The intervals where a reset signal is high within `[start, end]`, for the
/// crosshatch bands (mirrors `wave/clock.ts` reset-span walk).
pub fn reset_high_spans(
    _db: &mut TraceDb,
    _id: SignalId,
    _start: u64,
    _end: u64,
) -> Vec<(u64, u64)> {
    // U5: port the paginated high-span walk.
    Vec::new()
}
