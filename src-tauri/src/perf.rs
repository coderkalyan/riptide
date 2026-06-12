//! Perf sampler: aggregates pack/geometry/encode timings + frame counters and
//! emits throttled `UiEvent::Perf` samples while the HUD is enabled.
//!
//! OWNED BY UNIT U14.
//!
//! Self-contained — no AppState / tauri dependency. The render loop feeds it
//! per-frame phase timings via [`Sampler::record_frame`] and polls
//! [`Sampler::tick`] once per frame; a returned `PerfSample` is the throttled
//! (~4 Hz) payload to push down the UI event channel as `UiEvent::Perf`.
//! `perf_control` (U10) flips it via [`Sampler::set_enabled`] /
//! [`Sampler::reset`]. Time is injected (`now_ms` params, any monotonic
//! ms clock) so tests are deterministic.
#![allow(dead_code)] // exercised by unit tests; wired into the render loop at integration (U15)

use riptide_contract::ipc::PerfSample;

/// Rolling sample window (~4 s at 60 fps) — mirrors `WINDOW` in
/// `src/renderer/perf.ts`.
const WINDOW: usize = 240;

/// Minimum interval between emitted samples (~4 Hz).
const EMIT_INTERVAL_MS: f64 = 250.0;

/// Per-frame phase timings fed by the render loop. All values in ms.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct FrameTimings {
    /// Segment repack time this frame (0 when nothing repacked).
    pub pack_ms: f32,
    /// CPU geometry build (lines/rects/text batches).
    pub geometry_ms: f32,
    /// Command encode + submit.
    pub encode_ms: f32,
    /// GPU render-pass time via timestamp-query; `None` when unsupported or
    /// when the (asynchronously read) result isn't available this frame.
    pub gpu_pass_ms: Option<f32>,
}

/// Fixed-capacity rolling window of f64 samples.
struct Ring {
    buf: Vec<f64>,
    head: usize,
    len: usize,
}

impl Ring {
    fn new() -> Self {
        Self { buf: vec![0.0; WINDOW], head: 0, len: 0 }
    }

    fn push(&mut self, v: f64) {
        self.buf[self.head] = v;
        self.head = (self.head + 1) % self.buf.len();
        if self.len < self.buf.len() {
            self.len += 1;
        }
    }

    fn clear(&mut self) {
        self.head = 0;
        self.len = 0;
    }

    fn mean(&self) -> f64 {
        if self.len == 0 {
            return 0.0;
        }
        // The live window is the last `len` slots; when full that's the whole
        // buffer, otherwise slots [0, len).
        let sum: f64 = if self.len == self.buf.len() {
            self.buf.iter().sum()
        } else {
            self.buf[..self.len].iter().sum()
        };
        sum / self.len as f64
    }

    fn is_empty(&self) -> bool {
        self.len == 0
    }
}

/// Rolling-window perf sampler for the native render loop.
pub struct Sampler {
    enabled: bool,
    frame_count: u64,
    last_frame_ms: Option<f64>,
    last_emit_ms: Option<f64>,
    dt: Ring,       // inter-frame interval → fps
    pack: Ring,     // pack_ms
    geometry: Ring, // geometry_ms
    encode: Ring,   // encode_ms
    gpu: Ring,      // gpu_pass_ms (only frames where a result was available)
}

impl Sampler {
    pub fn new() -> Self {
        Self {
            enabled: false,
            frame_count: 0,
            last_frame_ms: None,
            last_emit_ms: None,
            dt: Ring::new(),
            pack: Ring::new(),
            geometry: Ring::new(),
            encode: Ring::new(),
            gpu: Ring::new(),
        }
    }

    /// HUD on/off (flipped by `perf_control`, U10). Frame recording stays on
    /// either way (cheap, mirrors the JS side's always-on metering); only
    /// emission is gated.
    pub fn set_enabled(&mut self, on: bool) {
        self.enabled = on;
    }

    pub fn enabled(&self) -> bool {
        self.enabled
    }

    /// Clears counters + rolling windows (the HUD "reset"). Keeps the enabled
    /// flag; the next `tick` after new frames emits immediately.
    pub fn reset(&mut self) {
        self.frame_count = 0;
        self.last_frame_ms = None;
        self.last_emit_ms = None;
        self.dt.clear();
        self.pack.clear();
        self.geometry.clear();
        self.encode.clear();
        self.gpu.clear();
    }

    /// Records one presented frame's phase timings. Call once per frame from
    /// the render loop with the same clock passed to `tick`.
    pub fn record_frame(&mut self, now_ms: f64, t: FrameTimings) {
        self.frame_count += 1;
        if let Some(prev) = self.last_frame_ms {
            let dt = now_ms - prev;
            if dt > 0.0 {
                self.dt.push(dt);
            }
        }
        self.last_frame_ms = Some(now_ms);
        self.pack.push(f64::from(t.pack_ms));
        self.geometry.push(f64::from(t.geometry_ms));
        self.encode.push(f64::from(t.encode_ms));
        if let Some(g) = t.gpu_pass_ms {
            self.gpu.push(f64::from(g));
        }
    }

    /// Returns the next sample to emit, or `None` while disabled, throttled
    /// (< ~250 ms since the last emit), or before any frame was recorded.
    pub fn tick(&mut self, now_ms: f64) -> Option<PerfSample> {
        if !self.enabled || self.frame_count == 0 {
            return None;
        }
        if let Some(last) = self.last_emit_ms
            && now_ms - last < EMIT_INTERVAL_MS
        {
            return None;
        }
        self.last_emit_ms = Some(now_ms);
        let dt_mean = self.dt.mean();
        Some(PerfSample {
            fps: if dt_mean > 0.0 { (1000.0 / dt_mean) as f32 } else { 0.0 },
            cpu_encode_ms: self.encode.mean() as f32,
            gpu_pass_ms: if self.gpu.is_empty() { None } else { Some(self.gpu.mean() as f32) },
            pack_ms: self.pack.mean() as f32,
            geometry_ms: self.geometry.mean() as f32,
            frame_count: self.frame_count,
        })
    }
}

impl Default for Sampler {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn timings(pack: f32, geom: f32, enc: f32, gpu: Option<f32>) -> FrameTimings {
        FrameTimings { pack_ms: pack, geometry_ms: geom, encode_ms: enc, gpu_pass_ms: gpu }
    }

    /// Feed `n` frames at a fixed interval starting at `t0`; returns the time
    /// of the last frame.
    fn feed_frames(s: &mut Sampler, t0: f64, n: usize, dt: f64, t: FrameTimings) -> f64 {
        let mut now = t0;
        for i in 0..n {
            now = t0 + i as f64 * dt;
            s.record_frame(now, t);
        }
        now
    }

    #[test]
    fn fps_over_rolling_window() {
        let mut s = Sampler::new();
        s.set_enabled(true);
        let last = feed_frames(&mut s, 0.0, 31, 16.0, timings(0.1, 0.2, 0.3, None));
        let sample = s.tick(last).expect("emits");
        assert!((sample.fps - 62.5).abs() < 1e-3, "fps {}", sample.fps);
        assert_eq!(sample.frame_count, 31);
    }

    #[test]
    fn fps_window_evicts_old_samples() {
        let mut s = Sampler::new();
        s.set_enabled(true);
        // Fill the whole window at 16 ms, then overwrite it entirely at 32 ms.
        let t1 = feed_frames(&mut s, 0.0, WINDOW + 1, 16.0, timings(0.0, 0.0, 0.0, None));
        feed_frames(&mut s, t1 + 32.0, WINDOW, 32.0, timings(0.0, 0.0, 0.0, None));
        let sample = s.tick(1e9).expect("emits");
        assert!((sample.fps - 31.25).abs() < 1e-3, "fps {}", sample.fps);
    }

    #[test]
    fn phase_means_and_gpu_some() {
        let mut s = Sampler::new();
        s.set_enabled(true);
        s.record_frame(0.0, timings(1.0, 2.0, 3.0, Some(4.0)));
        s.record_frame(16.0, timings(3.0, 4.0, 5.0, Some(6.0)));
        let sample = s.tick(16.0).expect("emits");
        assert!((sample.pack_ms - 2.0).abs() < 1e-6);
        assert!((sample.geometry_ms - 3.0).abs() < 1e-6);
        assert!((sample.cpu_encode_ms - 4.0).abs() < 1e-6);
        assert!((sample.gpu_pass_ms.expect("gpu") - 5.0).abs() < 1e-6);
    }

    #[test]
    fn gpu_none_when_no_timestamp_results() {
        let mut s = Sampler::new();
        s.set_enabled(true);
        s.record_frame(0.0, timings(0.0, 0.0, 0.0, None));
        let sample = s.tick(0.0).expect("emits");
        assert_eq!(sample.gpu_pass_ms, None);
    }

    #[test]
    fn gpu_mean_skips_frames_without_results() {
        let mut s = Sampler::new();
        s.set_enabled(true);
        s.record_frame(0.0, timings(0.0, 0.0, 0.0, Some(2.0)));
        s.record_frame(16.0, timings(0.0, 0.0, 0.0, None));
        s.record_frame(32.0, timings(0.0, 0.0, 0.0, Some(4.0)));
        let sample = s.tick(32.0).expect("emits");
        assert!((sample.gpu_pass_ms.expect("gpu") - 3.0).abs() < 1e-6);
    }

    #[test]
    fn throttles_to_4hz() {
        let mut s = Sampler::new();
        s.set_enabled(true);
        s.record_frame(0.0, FrameTimings::default());
        assert!(s.tick(0.0).is_some(), "first tick emits immediately");
        for t in [50.0, 100.0, 200.0, 249.9] {
            s.record_frame(t, FrameTimings::default());
            assert!(s.tick(t).is_none(), "throttled at t={t}");
        }
        assert!(s.tick(250.0).is_some(), "emits once the interval elapses");
        assert!(s.tick(300.0).is_none(), "throttle window restarts");
        assert!(s.tick(500.0).is_some());
    }

    #[test]
    fn disabled_emits_nothing() {
        let mut s = Sampler::new();
        s.record_frame(0.0, FrameTimings::default());
        assert!(s.tick(0.0).is_none(), "disabled by default");
        assert!(s.tick(1000.0).is_none());
        s.set_enabled(true);
        assert!(s.tick(2000.0).is_some(), "emits once enabled");
        s.set_enabled(false);
        assert!(s.tick(3000.0).is_none(), "silent again after disable");
    }

    #[test]
    fn no_emission_before_first_frame() {
        let mut s = Sampler::new();
        s.set_enabled(true);
        assert!(s.tick(0.0).is_none());
        s.record_frame(10.0, FrameTimings::default());
        assert!(s.tick(10.0).is_some());
    }

    #[test]
    fn reset_clears_counters_and_throttle() {
        let mut s = Sampler::new();
        s.set_enabled(true);
        feed_frames(&mut s, 0.0, 10, 16.0, timings(1.0, 1.0, 1.0, Some(1.0)));
        assert!(s.tick(144.0).is_some());
        s.reset();
        assert!(s.enabled(), "reset keeps the enabled flag");
        assert!(s.tick(145.0).is_none(), "no frames recorded since reset");
        s.record_frame(150.0, timings(2.0, 0.0, 0.0, None));
        let sample = s.tick(150.0).expect("emits immediately after reset");
        assert_eq!(sample.frame_count, 1);
        assert_eq!(sample.fps, 0.0, "no interval yet");
        assert!((sample.pack_ms - 2.0).abs() < 1e-6, "old window cleared");
        assert_eq!(sample.gpu_pass_ms, None, "old gpu samples cleared");
    }
}
