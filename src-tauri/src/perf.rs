//! Perf sampler: aggregates pack/geometry/encode timings + frame counters and
//! emits throttled `UiEvent::Perf` samples while the HUD is enabled.
//!
//! OWNED BY UNIT U14.
