//! GPU pass timing via wgpu timestamp queries (port of `gpu/timing.ts`).
//! Gracefully absent when the adapter lacks TIMESTAMP_QUERY.
//!
//! Frame flow (mirrors timing.ts begin/resolve/readback):
//! 1. `pass_timestamp_writes()` while building the render pass — reserves a
//!    readback buffer; `None` (timing skipped this frame) when the whole pool
//!    is still in flight.
//! 2. `resolve(encoder)` after `pass.end()`, before submit — resolves the
//!    query set and copies it into the reserved buffer.
//! 3. `readback()` after submit — kicks the async map (mapping before the
//!    submit that fills the buffer would invalidate the copy).
//! 4. `read(device)` any time — pumps callbacks (non-blocking poll) and
//!    returns the latest landed pass duration.
//!
//! OWNED BY UNIT U12.

use std::cell::Cell;
use std::sync::{Arc, Mutex};

use crate::device::Gpu;

/// Readback pool depth: `map_async` keeps a buffer checked out until its
/// callback lands, so a single buffer would stall timing every frame. 3 covers
/// the in-flight depth; when all are busy that frame simply isn't timed.
const POOL: usize = 3;

/// Two u64 timestamps (pass begin / pass end).
const READBACK_BYTES: u64 = 16;

#[non_exhaustive]
pub struct GpuTimer {
    query_set: wgpu::QuerySet,
    resolve_buf: wgpu::Buffer,
    /// Readback buffers not currently in flight; map_async callbacks push
    /// buffers back here once their readback lands (hence Arc).
    free: Arc<Mutex<Vec<wgpu::Buffer>>>,
    /// Reserved by `pass_timestamp_writes` for the frame being encoded
    /// (Cell: reservation happens through `&self`).
    current: Cell<Option<wgpu::Buffer>>,
    /// Resolved + copied this frame; its map is kicked off in `readback`.
    pending: Option<wgpu::Buffer>,
    latest_ms: Arc<Mutex<Option<f32>>>,
    /// Nanoseconds per timestamp tick (`Queue::get_timestamp_period`).
    period_ns: f32,
}

impl GpuTimer {
    /// None when the device lacks timestamp-query support.
    pub fn new(gpu: &Gpu) -> Option<Self> {
        if !gpu
            .device
            .features()
            .contains(wgpu::Features::TIMESTAMP_QUERY)
        {
            return None;
        }
        let query_set = gpu.device.create_query_set(&wgpu::QuerySetDescriptor {
            label: Some("gpu-timer"),
            ty: wgpu::QueryType::Timestamp,
            count: 2,
        });
        let resolve_buf = gpu.device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("gpu-timer-resolve"),
            size: READBACK_BYTES,
            usage: wgpu::BufferUsages::QUERY_RESOLVE | wgpu::BufferUsages::COPY_SRC,
            mapped_at_creation: false,
        });
        let pool = (0..POOL)
            .map(|_| {
                gpu.device.create_buffer(&wgpu::BufferDescriptor {
                    label: Some("gpu-timer-readback"),
                    size: READBACK_BYTES,
                    usage: wgpu::BufferUsages::MAP_READ | wgpu::BufferUsages::COPY_DST,
                    mapped_at_creation: false,
                })
            })
            .collect();
        Some(Self {
            query_set,
            resolve_buf,
            free: Arc::new(Mutex::new(pool)),
            current: Cell::new(None),
            pending: None,
            latest_ms: Arc::new(Mutex::new(None)),
            period_ns: gpu.queue.get_timestamp_period(),
        })
    }

    /// Timestamp writes to attach to the frame's render pass. `None` when
    /// timing can't run this frame (every readback buffer still mapped in
    /// flight) — `resolve` then no-ops too, so a frame without timestamp
    /// writes is never resolved against stale query data.
    pub fn pass_timestamp_writes(&self) -> Option<wgpu::RenderPassTimestampWrites<'_>> {
        let buf = match self.current.take() {
            // Armed but never resolved (pass dropped?) — reuse the reservation.
            Some(b) => b,
            None => self.free.lock().unwrap().pop()?,
        };
        self.current.set(Some(buf));
        Some(wgpu::RenderPassTimestampWrites {
            query_set: &self.query_set,
            beginning_of_pass_write_index: Some(0),
            end_of_pass_write_index: Some(1),
        })
    }

    /// After `pass.end()`, before submit: resolve the query set into this
    /// frame's readback buffer.
    pub fn resolve(&mut self, encoder: &mut wgpu::CommandEncoder) {
        let Some(buf) = self.current.take() else {
            return;
        };
        encoder.resolve_query_set(&self.query_set, 0..2, &self.resolve_buf, 0);
        encoder.copy_buffer_to_buffer(&self.resolve_buf, 0, &buf, 0, READBACK_BYTES);
        // A prior frame's resolve that was never followed by `readback` left a
        // pending buffer that was never mapped — safe to return to the pool.
        if let Some(stale) = self.pending.replace(buf) {
            self.free.lock().unwrap().push(stale);
        }
    }

    /// After submit: map this frame's readback buffer asynchronously. The
    /// result lands in a later `read` — a frame or two late, fine for rolling
    /// averages.
    pub fn readback(&mut self) {
        let Some(buf) = self.pending.take() else {
            return;
        };
        let free = Arc::clone(&self.free);
        let latest = Arc::clone(&self.latest_ms);
        let period_ns = self.period_ns;
        let handle = buf.clone();
        buf.slice(..).map_async(wgpu::MapMode::Read, move |res| {
            if res.is_ok() {
                {
                    let data = handle.slice(..).get_mapped_range();
                    let t0 = u64::from_le_bytes(data[0..8].try_into().unwrap());
                    let t1 = u64::from_le_bytes(data[8..16].try_into().unwrap());
                    if let Some(ticks) = t1.checked_sub(t0) {
                        let ms = ticks as f64 * f64::from(period_ns) / 1e6;
                        *latest.lock().unwrap() = Some(ms as f32);
                    }
                }
                handle.unmap();
            }
            free.lock().unwrap().push(handle);
        });
    }

    /// Latest completed pass duration in ms, if a readback has landed. Pumps
    /// map callbacks with a non-blocking poll; never stalls the frame.
    pub fn read(&mut self, device: &wgpu::Device) -> Option<f32> {
        let _ = device.poll(wgpu::PollType::Poll);
        *self.latest_ms.lock().unwrap()
    }
}
