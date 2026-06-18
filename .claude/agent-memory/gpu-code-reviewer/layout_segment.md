---
name: layout-segment-rowinfo
description: PackedSegment=3×u32, RowInfo=5×u32 (byte-stride pools, bytes_per_sample + flags). Zig+WGSL+labels.wgsl all in sync as of perf/pill-buffer-consolidation.
metadata:
  type: project
---

**PackedSegment = 3×u32 = 12 bytes.** Canonical: `native/src/segments.zig` `PackedSegment` + `digital.wgsl` `Segment` (+ read in `labels.zig`/`labels.ts` as 3×u32). Stale comment in segments.zig:13 still says "4 × u32 = 16 bytes" — WRONG, it's 3×u32; ignore the comment.
- t_start: u32, t_end: u32, row_flags: u32
- row_flags: `[15:0]` row, `[16]` shade, `[17]` right edge, `[18]` rising, `[19]` falling, `[20]` mute, `[21]` rising-edge-left (caret right arm at left boundary). FLAG_* consts in segments.zig, F_* in digital.wgsl VertexData.flags.

**RowInfo = 7×u32 = 28 bytes** (EVOLVED from 5×u32; CLAUDE.md still says 5×u32 = STALE, code is the truth). Declared in THREE places + ROW_INFO_WORDS=7 in `digital.ts` — all four agree as of this review (2026-06): `segments.zig` RowInfo, `digital.wgsl` RowInfo, `labels.wgsl` RowInfo.
- x0_offset, x1_offset, bytes_per_sample, segment_start, flags, **y_offset, height** (the two new words: per-row vertical layout, CSS px stored as f32 BITS — shader bitcasts; native emits 0, renderer writes via `setRowLayout`).
- Offsets are **BYTE** offsets into the (u32-typed) pools. `bytes_per_sample = ceil(bit_width/8)` (= tide's Type.bytes()). Pools are **byte-stride** (tide's raw byte planes memcpy'd verbatim by pack.zig setSamples — no word repack). Shader `decodeSample` byte-addresses: `bi >> 2` word index, `(bi & 3)*8` shift, `& 0xff` mask, OR-folds all bytes_per_sample bytes for whole-sample non-zeroness.
- `flags` bit 0 = ROW_FLAG_DIM (eye toggle), **bit 1 = ROW_FLAG_HIGHLIGHT (selection)** — both set together by `setRowFlags` (digital.ts; renamed from setDimFlags). Small writeBuffer, no repack, scales past 32 rows. Read by digital.wgsl (F_DIM → 28% toward bg, F_HIGHLIGHT → brighter alpha) AND labels.wgsl (dim label). NOTE: viewport.selected_row is now DEAD (declared in all 5 WGSL, read nowhere — highlight moved to RowInfo.flags).

Sample index for instance ii of a row = `ii - segment_start`; byte base = `x0_offset + sample_index*bps`. Each row filled by exactly ONE signal contiguously (Zig asserts `!ra.started` + `segment_start = target.items.len`). Two pipelines partition by width: `width > 1` → multi (pill), else single (line) — see main.zig getMockSegments target assignment.

`finalize` pads each pool to 4-byte multiple (zeros, inert in OR-fold) so writeBuffer accepts it + shader array<u32> reads stay in-bounds even for the last sample's spill. Asserts every segment's row → bytes_per_sample>0, once at build.

**TS Segment interface in `gpu/data.ts` is gone** — data.ts now only has the Viewport interface + writeViewportInto + mock constants. No dead 5×u32 builders anymore.
