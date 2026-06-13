//! Ruler/time/clock-cycle formatting — port of `src/renderer/wave/format.ts`.
//!
//! OWNED BY UNIT U5 (together with `clock.rs` and `geometry.rs`). Internal
//! helper signatures are the unit's to shape; only `geometry::build_frame_geometry`
//! and `clock::detect_clock_grid` are cross-unit surfaces.
//!
//! All math is f64, mirroring the JS number semantics of the TS source line by
//! line. Time is ticks (the trace's native unit, ns for the bundled mock).

use riptide_contract::spec::ClockGrid;

/// JS `Math.round` (round half toward +∞), which differs from Rust's
/// `f64::round` (half away from zero) for negative `.5` inputs.
pub fn js_round(x: f64) -> f64 {
    (x + 0.5).floor()
}

/// "Nice" ruler-tick spacing — multiples of {1,2,5} × 10^n — so the visible
/// range gets ~8 labels (`format.ts rulerSpacing`).
pub fn ruler_spacing(visible_ticks: f64) -> f64 {
    let target = visible_ticks / 8.0;
    let exp = target.log10().floor();
    let base = 10f64.powf(exp);
    let m = target / base;
    if m < 2.0 {
        base
    } else if m < 5.0 {
        2.0 * base
    } else {
        5.0 * base
    }
}

/// `format.ts formatRulerLabel`: `"<t> ns"` with enough decimals for
/// sub-tick spacings (spacing ≥ 1 → 0 decimals).
fn format_ruler_label(t: f64, spacing: f64) -> String {
    let decimals = if spacing >= 1.0 {
        0
    } else {
        (-spacing.log10().floor()).max(0.0) as usize
    };
    format!("{t:.decimals$} ns")
}

/// Tick positions + labels of one ruler pass.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct RulerTicks {
    pub ticks: Vec<f64>,
    pub labels: Vec<String>,
}

/// Absolute-time ruler ticks on "nice" spacing (`format.ts dynamicRulerTicks`).
pub fn dynamic_ruler_ticks(start_ticks: f64, visible_ticks: f64) -> RulerTicks {
    let spacing = ruler_spacing(visible_ticks);
    let first = (start_ticks / spacing).ceil() * spacing;
    let mut out = RulerTicks::default();
    let end = start_ticks + visible_ticks + spacing * 1e-6;
    // Same accumulating float loop as the TS (`for (let t = first; t <= end;
    // t += spacing)`) so tick positions stay bit-identical.
    let mut t = first;
    while t <= end {
        out.ticks.push(t);
        out.labels.push(format_ruler_label(t, spacing));
        t += spacing;
    }
    out
}

// Clock math is parameterized by the timebase ClockGrid: cycle c's reference
// edge lands at `g.phase + (c-1)*g.period` (e.g. 5, 15, 25… for phase 5,
// period 10).

/// Rising edges crossed moving from one tick to the other, in (a, b]
/// (`format.ts clockEdgesBetween`).
pub fn clock_edges_between(a: f64, b: f64, g: &ClockGrid) -> i64 {
    let lo = a.min(b);
    let hi = a.max(b);
    let eps = g.period * 1e-6;
    let k_hi = ((hi - g.phase + eps) / g.period).floor();
    let k_lo = ((lo - g.phase + eps) / g.period).floor();
    let k_start = (k_lo + 1.0).max(0.0);
    (k_hi - k_start + 1.0).max(0.0) as i64
}

/// Integer cycle index a tick sits in (the most recent reference edge). Cycle
/// 1's edge is at `g.phase` (`format.ts clockCycleOf`).
pub fn clock_cycle_of(tick: f64, g: &ClockGrid) -> i64 {
    let eps = g.period * 1e-6;
    ((tick - g.phase + eps) / g.period).floor() as i64 + 1
}

/// Inverse on edit commit: snap a typed cycle count to a tick
/// (`format.ts clockCycleToTick`).
pub fn clock_cycle_to_tick(cycle: i64, g: &ClockGrid) -> f64 {
    g.phase + (cycle - 1) as f64 * g.period
}

/// `"#<cycle>"` (`format.ts formatClockWhole`).
pub fn format_clock_whole(tick: f64, g: &ClockGrid) -> String {
    format!("#{}", clock_cycle_of(tick, g))
}

/// Clock-anchored ruler: ticks land on clock reference edges, labels count
/// cycles (`format.ts clockRulerTicks`).
pub fn clock_ruler_ticks(start_ticks: f64, visible_ticks: f64, g: &ClockGrid) -> RulerTicks {
    let edge0 = g.phase;
    let visible_cycles = visible_ticks / g.period;
    let cycle_step = js_round(ruler_spacing(visible_cycles)).max(1.0);
    let start_cycle = (start_ticks - edge0) / g.period + 1.0;
    let mut c = cycle_step.max((start_cycle / cycle_step).ceil() * cycle_step);
    let mut out = RulerTicks::default();
    let end = start_ticks + visible_ticks + g.period * 1e-6;
    loop {
        let t = edge0 + (c - 1.0) * g.period;
        if t > end {
            break;
        }
        out.ticks.push(t);
        out.labels.push(format!("#{}", c as i64));
        c += cycle_step;
    }
    out
}

/// VCD time unit (`hier/types.ts TimeUnit`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TimeUnit {
    S,
    Ms,
    Us,
    Ns,
    Ps,
    Fs,
}

impl TimeUnit {
    /// Power-of-ten exponent vs seconds (`format.ts TIME_UNIT_EXP`).
    pub fn exp(self) -> i32 {
        match self {
            TimeUnit::S => 0,
            TimeUnit::Ms => -3,
            TimeUnit::Us => -6,
            TimeUnit::Ns => -9,
            TimeUnit::Ps => -12,
            TimeUnit::Fs => -15,
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            TimeUnit::S => "s",
            TimeUnit::Ms => "ms",
            TimeUnit::Us => "us",
            TimeUnit::Ns => "ns",
            TimeUnit::Ps => "ps",
            TimeUnit::Fs => "fs",
        }
    }
}

/// `hier/types.ts Timescale` — VCD `$timescale` value/unit plus the file's
/// optional finer time precision.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Timescale {
    pub value: u32,
    pub unit: TimeUnit,
    pub precision: Option<(u32, TimeUnit)>,
}

/// Verilog-style timescale label: `<unit> / <precision>` (precision optional)
/// (`format.ts formatTimescale`).
pub fn format_timescale(ts: &Timescale) -> String {
    let unit = format!("{} {}", ts.value, ts.unit.label());
    match ts.precision {
        Some((v, u)) => format!("{unit} / {v} {}", u.label()),
        None => unit,
    }
}

/// Decimal places every time readout zero-pads to, derived from the file's
/// time precision (`format.ts timeDecimals`). E.g. 1 ns unit / 1 ps precision
/// → 3; / 10 ps → 2; no precision → 0.
pub fn time_decimals(ts: &Timescale) -> u32 {
    let Some((pv, pu)) = ts.precision else {
        return 0;
    };
    let exp = pu.exp() - ts.unit.exp();
    // `String(value).length - 1` — digits beyond the leading one.
    let extra = pv.to_string().len() as i32 - 1;
    (-exp - extra).max(0) as u32
}

/// `tick.toFixed(decimals)` (`format.ts formatTime`; the TS bakes the file's
/// TIME_DECIMALS in at module load — here the caller passes it).
pub fn format_time(tick: f64, decimals: u32) -> String {
    format!("{tick:.0$}", decimals as usize)
}

/// Snap to the nearest reference edge of the timebase grid
/// (`format.ts snapToClockEdge`).
pub fn snap_to_clock_edge(tick: f64, g: &ClockGrid) -> f64 {
    js_round((tick - g.phase) / g.period) * g.period + g.phase
}

#[cfg(test)]
mod tests {
    use super::*;

    fn grid(phase: f64, period: f64) -> ClockGrid {
        ClockGrid { phase, period, valid: true }
    }

    #[test]
    fn ruler_spacing_nice_steps() {
        // target = visible/8; spacing snaps to 1/2/5 × 10^n.
        assert_eq!(ruler_spacing(90.0), 10.0); // target 11.25 → m 1.125 → 10
        assert_eq!(ruler_spacing(100.0), 10.0); // target 12.5 → m 1.25 → 10
        assert_eq!(ruler_spacing(160.0), 20.0); // target 20 → m 2 → 20
        assert_eq!(ruler_spacing(400.0), 50.0); // target 50 → m 5 → 50
        assert_eq!(ruler_spacing(800.0), 100.0); // target 100 → m 1 → 100
        assert_eq!(ruler_spacing(4.0), 0.5); // target 0.5 → m 5 → 0.5
    }

    #[test]
    fn dynamic_ticks_mock_view() {
        // The bundled mock's 0–90 view: spacing 10, ticks 0,10,…,90.
        let r = dynamic_ruler_ticks(0.0, 90.0);
        assert_eq!(r.ticks, (0..=9).map(|k| k as f64 * 10.0).collect::<Vec<_>>());
        assert_eq!(r.labels[0], "0 ns");
        assert_eq!(r.labels[9], "90 ns");
    }

    #[test]
    fn dynamic_ticks_subunit_decimals() {
        // visible 4 → spacing 0.5 → 1 decimal place.
        let r = dynamic_ruler_ticks(0.0, 4.0);
        assert_eq!(r.labels[0], "0.0 ns");
        assert_eq!(r.labels[1], "0.5 ns");
    }

    #[test]
    fn dynamic_ticks_offset_start() {
        // first = ceil(start/spacing)*spacing.
        let r = dynamic_ruler_ticks(13.0, 90.0);
        assert_eq!(r.ticks[0], 20.0);
        assert_eq!(*r.ticks.last().unwrap(), 100.0);
    }

    #[test]
    fn clock_cycles() {
        let g = grid(5.0, 10.0);
        assert_eq!(clock_cycle_of(5.0, &g), 1);
        assert_eq!(clock_cycle_of(14.0, &g), 1);
        assert_eq!(clock_cycle_of(15.0, &g), 2);
        assert_eq!(clock_cycle_to_tick(3, &g), 25.0);
        assert_eq!(format_clock_whole(25.0, &g), "#3");
    }

    #[test]
    fn edges_between() {
        let g = grid(5.0, 10.0);
        // Edges 5,15,25 ∈ (0,30].
        assert_eq!(clock_edges_between(0.0, 30.0, &g), 3);
        assert_eq!(clock_edges_between(30.0, 0.0, &g), 3); // order-insensitive
        assert_eq!(clock_edges_between(5.0, 14.0, &g), 0); // (5,14] holds none
        assert_eq!(clock_edges_between(4.0, 5.0, &g), 1); // edge at 5 included
        assert_eq!(clock_edges_between(7.0, 7.5, &g), 0);
    }

    #[test]
    fn clock_ruler_mock_view() {
        // 0–90 view, phase 5 / period 10: visibleCycles 9 → cycleStep 1;
        // startCycle 0.5 → first c = 1; ticks 5,15,…,85 = cycles #1..#9.
        let g = grid(5.0, 10.0);
        let r = clock_ruler_ticks(0.0, 90.0, &g);
        assert_eq!(r.ticks, (0..9).map(|k| 5.0 + k as f64 * 10.0).collect::<Vec<_>>());
        assert_eq!(r.labels.first().unwrap(), "#1");
        assert_eq!(r.labels.last().unwrap(), "#9");
    }

    #[test]
    fn clock_ruler_decimated() {
        // 1000 ticks / period 10 → 100 cycles visible. cycleStep =
        // max(1, round(rulerSpacing(100))). rulerSpacing snaps target 12.5 to
        // the nearest {1,2,5}×10^n = 10, so cycleStep = round(10) = 10 (NOT
        // 13 — rulerSpacing returns the snapped spacing, not the raw target).
        // first c = max(10, ceil(startCycle/10)*10) with startCycle 0.5 → 10.
        let g = grid(5.0, 10.0);
        let r = clock_ruler_ticks(0.0, 1000.0, &g);
        let step = 10.0;
        assert_eq!(r.labels[0], "#10");
        assert_eq!(r.ticks[0], 5.0 + (step - 1.0) * 10.0); // edge0 + (c-1)*period = 95
        assert_eq!(r.labels[1], "#20");
    }

    #[test]
    fn timescale_decimals() {
        let ns = Timescale { value: 1, unit: TimeUnit::Ns, precision: None };
        assert_eq!(time_decimals(&ns), 0);
        let ps1 =
            Timescale { value: 1, unit: TimeUnit::Ns, precision: Some((1, TimeUnit::Ps)) };
        assert_eq!(time_decimals(&ps1), 3);
        let ps10 =
            Timescale { value: 1, unit: TimeUnit::Ns, precision: Some((10, TimeUnit::Ps)) };
        assert_eq!(time_decimals(&ps10), 2);
        let fs100 =
            Timescale { value: 1, unit: TimeUnit::Ns, precision: Some((100, TimeUnit::Fs)) };
        assert_eq!(time_decimals(&fs100), 4);
        assert_eq!(format_timescale(&ps10), "1 ns / 10 ps");
        assert_eq!(format_timescale(&ns), "1 ns");
    }

    #[test]
    fn format_time_padding() {
        assert_eq!(format_time(5.0, 0), "5");
        assert_eq!(format_time(5.0, 2), "5.00");
        assert_eq!(format_time(0.6, 0), "1"); // toFixed rounds
        assert_eq!(format_time(12.345, 2), "12.35");
    }

    #[test]
    fn snap_rounds_like_js() {
        let g = grid(5.0, 10.0);
        assert_eq!(snap_to_clock_edge(12.0, &g), 15.0);
        assert_eq!(snap_to_clock_edge(10.0, &g), 15.0); // 0.5 → JS rounds up
        assert_eq!(snap_to_clock_edge(9.0, &g), 5.0);
        // Negative half: (-10-5)/10 = -1.5 → JS Math.round(-1.5) = -1 → -5.
        assert_eq!(snap_to_clock_edge(-10.0, &g), -5.0);
    }
}
