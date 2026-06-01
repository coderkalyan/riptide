---
name: Segment GPU layout (current)
description: Actual Segment struct byte layout shared between Zig and WGSL — supersedes stale CLAUDE.md "5×u32" claim
type: project
---

The `Segment`/`PackedSegment` struct is currently **3×u32 = 12 bytes**, NOT 5×u32 as CLAUDE.md states.

Layout (matches `native/src/segments.zig` `PackedSegment` and `digital.wgsl` `Segment`):
- `t_start: u32`
- `t_end: u32`
- `row_flags: u32` — `[15:0]` row, `[16]` shade, `[17]` right edge, `[18]` rising, `[19]` falling, `[20]` mute

Sample values (lsb/msb) were factored out into shared bit-packed pools `x0_pool`/`x1_pool` indexed via `RowInfo { x0_offset_u32, x1_offset_u32, bits_per_sample, segment_start }` — `bits_per_sample` is nextPow2 of bit_width so samples never cross u32 boundaries.

**Why:** Zig backend (`native/src/segments.zig`) became the canonical GPU producer. The TS `Segment` interface in `src/renderer/gpu/data.ts` still has `valueLsb`/`valueMsb` and TS builders still produce 5×u32 packing — but **none of that TS code feeds the GPU anymore**. It's vestigial; only `MOCK_SCENE.segments` (from `hier/mock`) is consumed for CPU-side cursor lookup.

**How to apply:** When reviewing GPU layout sync, check Zig ↔ WGSL only. The TS Segment interface is legacy. Flag any new code that re-introduces 5×u32 assumptions or adds value fields back to the GPU Segment.
