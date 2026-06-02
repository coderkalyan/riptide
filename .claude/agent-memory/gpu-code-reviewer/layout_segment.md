---
name: Segment + RowInfo GPU layout (current)
description: PackedSegment=3×u32, RowInfo=4×u32 with words_per_sample (word-stride pools). Zig+WGSL canonical; TS Segment is dead code.
metadata:
  type: project
---

**PackedSegment = 3×u32 = 12 bytes** (NOT 5×u32 as CLAUDE.md prose says elsewhere). Canonical defs: `native/src/segments.zig` `PackedSegment` and `digital.wgsl` `Segment`.
- t_start: u32
- t_end: u32
- row_flags: u32 — `[15:0]` row, `[16]` shade, `[17]` right edge, `[18]` rising, `[19]` falling, `[20]` mute, `[21]` rising-edge-left

**RowInfo = 4×u32 = 16 bytes** (`segments.zig` + `digital.wgsl`):
- x0_offset_u32, x1_offset_u32, words_per_sample, segment_start

`words_per_sample = ceil(bit_width/32)` (changed from earlier `bits_per_sample`=nextPow2). Each sample = that many consecutive u32 words in shared `x0Pool`/`x1Pool` (LSB/MSB planes), full declared width, little-endian, zero-padded. Sample index for instance ii of a row = `ii - segment_start`; base word = `sample_index * words_per_sample`. Shader `decodeSample` OR-folds all words (only needs whole-sample non-zeroness for line/crosshatch/color). Per-row segments MUST be contiguous in their pipeline (Zig asserts `segment_start + count == target.len`).

Two pipelines partition by width: `width > 1` → multi (pill), else single (line). See main.zig getMockSegments.

**TS Segment interface (`gpu/data.ts`) is DEAD CODE** — has valueLsb/valueMsb + 5×u32 builders (buildDataSignal/buildClockSegments/buildSegments, CYCLE_DURS, valueBits, sameValue, RawSegmentSpec, maskForWidth, SegValue). None feeds the GPU anymore; the native Zig path is canonical. `unpackSegmentHeaders` (reads 3×u32) IS live (used for pill labels in buildMultiLabels). Flag any new code re-introducing 5×u32 or value fields on the GPU Segment.

**How to apply:** verify Zig↔WGSL only for layout sync. Pools are word-stride; GPU only renders ≤32-bit rows but DB stores full width (mock_db MAX_VALUE_BYTES=1024 = 8192-bit). `finalize` asserts every segment's row points to a populated RowInfo (words_per_sample>0) — once at build, not per-frame.
