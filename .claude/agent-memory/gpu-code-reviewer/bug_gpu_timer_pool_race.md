---
name: GpuTimer readback-buffer pool accounting bug
description: timing.ts begin() checks free.length but doesn't reserve; resolve() pops. A skipped-timing frame can still consume a buffer / mis-account. Perf-only.
metadata:
  type: project
---

`gpu/timing.ts` `createGpuTimer` pool state machine is subtly wrong (perf-overlay only — never corrupts render output, only GPU-ms numbers / can wedge timing).

The intended invariant: `begin()` reserves a free readback buffer for this frame; `resolve()` uses it; `readback()` returns it on mapAsync completion. But `begin()` only *reads* `free.length` to set `active`, it does NOT pop. `resolve()` is what pops (`free.pop()`). So between begin() and resolve() nothing is reserved. In the normal single-threaded frame flow (begin→resolve→readback all in one renderFrame call) this happens to work because no other begin() interleaves. But:
- `begin()` returns `undefined` and sets `active=false` when `free.length===0`, yet `resolve()`/`readback()` early-return on `!active` — so that part is consistent.
- The real fragility: `active` is a single shared bool, and `current` a single buffer ref. The design assumes strict begin→resolve→readback ordering with no re-entrancy. It's fine today (renderFrame is synchronous and serial) but is NOT a real pool — the 3-buffer pool only helps because mapAsync completions (readback's .then) return buffers to `free` across frames. Effectively depth-3 in-flight works by luck of ordering, not by reservation.

**Verdict:** low priority. Flag only as a latent correctness smell if someone reworks frame submission to be concurrent / multi-pass-timed. Suggested clean fix: pop in begin() (reserve), store the popped buffer, use it in resolve(), so the buffer is owned for the whole begin→readback lifetime. Do not present this as a render-correctness bug.
