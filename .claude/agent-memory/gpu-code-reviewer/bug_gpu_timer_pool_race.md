---
name: gpu-timer-pool-fixed
description: timing.ts GpuTimer pool race is FIXED — begin() now reserves via free.pop() into `current`, held through readback. Don't re-flag.
metadata:
  type: project
---

**RESOLVED.** The old GpuTimer pool accounting bug is fixed in `gpu/timing.ts`. `begin()` now does `current = free.pop() ?? null` (reserves a buffer for the whole begin→resolve→readback lifetime); `resolve()`/`readback()` early-return on `!current`; `readback()` nulls `current` and re-pushes the buffer to `free` once mapAsync lands (both .then and .catch paths). Pool depth 3 covers in-flight depth; if all busy, timing skips that frame cleanly. Perf-overlay only; never affected render output. Do not re-flag.
