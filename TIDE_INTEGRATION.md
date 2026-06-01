# Tide → Riptide integration (MVP)

This document records how the `tide` waveform database was ported onto Riptide's
pool-based WebGPU renderer, and exactly which pieces are still **mocked in
TypeScript** because tide doesn't yet carry that information.

The end goal: opening a real VCD/FST in tide should feed Riptide directly with
**zero** mocking. Everything in the "Mocked in TS" section below is a temporary
shim to be deleted as tide grows the missing capabilities.

Branch context: `tide` lives at `../tide` (sibling of this repo); `native/build.zig.zon`
references it as `../../tide` relative to `native/`.

---

## 1. Data flow overview

```
 tide.Database (per-signal transition store)
        │  db.query(id, 0, END) → Query{ timestamps[], x0s[], x1s[], type }
        ▼
 native/src/pack.zig  packQuery()         ── per transition ──┐
        │  readBits(bytes) → (lsb,msb)                         │
        ▼                                                      │
 native/src/segments.zig  Scene.pushSegment()                 │
        │   • PackedSegment{t_start,t_end,row_flags} → multi/single list
        │   • (lsb,msb) appended to per-row sample accumulators
        ▼
 Scene.finalize()  packRow()
        │   • bit-pack each row's samples → x0_pool / x1_pool (u32 words)
        │   • RowInfo{x0_off,x1_off,bits_per_sample,segment_start} per row
        ▼
 native/src/main.zig  getMockSegments()
        │   • napi ArrayBuffers: multi, single, rowInfo, x0Pool, x1Pool
        ▼
 src/renderer/native.ts → gpu/digital.ts (storage buffers)
        ▼
 digital.wgsl  decodeSample()  ← reads pools per instance, on the GPU
```

The single most important fact: **a tide transition, a `PackedSegment`, and a
pool sample are 1:1.** tide already stores one record per value change (not per
tick), which is exactly the granularity the renderer's per-segment pool expects.
So the port is a *re-pack*, never a reinterpretation of the data.

---

## 2. Data transforms, copies, re-packing, bit calculations

### 2.1 tide query output (source format)
`db.query(id, start, end)` (`tide/src/db.zig`) returns a `Query`:
- `timestamps: []const Timestamp` — one entry per transition in range.
- `x0s: []const u8`, `x1s: []const u8` — **byte arrays**, `bytes_per_sample =
  type.bytes()` bytes per transition, little-endian, full declared width.
- `type.width` — bit width; `len` — transition count.
- `query(id, t, t)` returns the single sample **active at** `t` (tide sets
  `lo = upperBound(timestamps, t) - 1`). Used for point lookups.

The `(x0, x1)` pair is the standard 4-state encoding: `(0,0)=0`, `(1,0)=1`,
`(0,1)=x`, `(1,1)=z` **per bit** (lsb stream = value bits, msb stream = unknown
bits). This matches Riptide's existing LSB/MSB convention exactly — no remap.

### 2.2 `readBits` — bytes → u32 (`pack.zig`)
tide stores `bps` little-endian bytes per sample; the renderer works in `u32`
lsb/msb. Transform:
```zig
for (x0, 0..) |b, i| lsb |= @as(u32, b) << @intCast(i * 8);
for (x1, 0..) |b, i| msb |= @as(u32, b) << @intCast(i * 8);
```
Width ≤ 32 ⇒ `bps ≤ 4`, so this never overflows a `u32`.

### 2.3 `packQuery` — transitions → segments + samples (`pack.zig`)
Walks the query once. For transition `i`:
- `t_start = timestamps[i]`, `t_end = timestamps[i+1]` (or `end_t` for the last).
- `bits = readBits(...)`.
- **Flag computation** (mirrors the old `mock_scene.zig` byte-for-byte so GPU
  output is identical):
  - `FLAG_SHADE` (bit 16) — data signals only (`shaded && kind == .data`).
  - `FLAG_RIGHT_EDGE` (bit 17) — there is a next transition; **suppressed** for
    1-bit signals when either side is x/z (no clean edge to draw).
  - `FLAG_RISING_EDGE` (bit 18) — clock low half-period with a successor.
  - `FLAG_RISING_EDGE_LEFT` (bit 21) — clock high half-period (owns the right
    arm of the rising caret at its left boundary). **This flag was added to the
    tide packer** — backend's original `pack.zig` lacked it, which would have
    broken the clock caret on main's renderer.
  - `FLAG_MUTE` (bit 20) — gated signal whose gate isn't logic-1 at `t_start`
    (see `gateMutedAt`); reproduces `MUTE_IN`/`MUTE_OUT`.
  - Low 16 bits = row index.
- Pushed via `Scene.pushSegment(target, row, width, t_start, t_end, bits, flags)`.

### 2.4 `Scene.pushSegment` — split timing from value (`segments.zig`)
Appends a lean `PackedSegment{ t_start, t_end, row_flags }` (3×u32 = 12 B) to the
multi or single pipeline list, **and** appends `bits.lsb` / `bits.msb` to that
row's `lsbs` / `msbs` accumulators. Asserts each row's segments are contiguous in
the pipeline (so a single `segment_start` index suffices on the GPU).

### 2.5 `finalize` / `packRow` — bit-pack the value pools (`segments.zig`)
This is the only place where the packing **differs** from tide's layout:

| | tide `x0s`/`x1s` | Riptide `x0Pool`/`x1Pool` |
|---|---|---|
| granularity | `bytes_per_sample` **bytes** / sample | `bits_per_sample` **bits** / sample |
| `bits_per_sample` | `8 * type.bytes()` | `nextPow2(width)`, ≤ 32 |
| container | flat byte slice per signal | shared `u32` word pools, all rows |

`packRow` packs a row's sample list into `u32` words:
```
bits_per_sample = nextPow2(width)         // pow2 ≤ 32 ⇒ samples never straddle a u32
bit_off  = sample_index * bits_per_sample
word_idx = bit_off >> 5
shift    = bit_off & 31
word[word_idx] |= (value & mask) << shift
```
`RowInfo{ x0_offset_u32, x1_offset_u32, bits_per_sample, segment_start }` records
where each row's run starts in the pools and its first instance index.

> So tide's `x0s`/`x1s` are **not** memcpy'd into the pools. They carry the same
> values, but full-width byte-granular vs. `nextPow2`-bit-granular. `readBits` +
> `packRow` bridge the two. (A future optimization could make tide emit the
> bit-packed layout directly and skip the repack.)

### 2.6 Shader decode (`digital.wgsl`, unchanged)
Per instance `ii` of row `r`:
```
sample_index = ii - RowInfo.segment_start
bit_off = sample_index * bits_per_sample
mask    = ~0u >> (32 - bits_per_sample)
lsb = (x0_pool[x0_offset_u32 + (bit_off>>5)] >> (bit_off&31)) & mask
msb = (x1_pool[x1_offset_u32 + (bit_off>>5)] >> (bit_off&31)) & mask
```
Exactly inverts `packRow`.

### 2.7 `getValueAt` — CPU point lookup (`pack.zig` / `main.zig`)
Replaces the old JS scan over a segment list. `valueAt(db, id, t)` does
`db.query(id, t, t)`, takes the last (active) sample, `readBits`. Returns
`{ lsb, msb }` to JS. Used by the active-signal value column, hover readout, and
the multi-bit pill labels.

### 2.8 napi ArrayBuffer copy (`main.zig`)
V8's sandbox in Electron rejects external pointers, so every buffer is allocated
with `napi_create_arraybuffer` (V8 owns the store) and the packed bytes are
`@memcpy`'d in. Applies to segments (`packSegmentsInto`), `RowInfo`
(`packRowInfosInto`), and the raw `u32` pools.

### 2.9 Multi-bit pill labels (`App.tsx`)
The value text drawn inside each multi-bit pill no longer comes from a JS segment
carrying its value (segments are valueless now). Instead:
1. `unpackSegmentHeaders(NATIVE.multi, count)` → `{tStart, tEnd, rowFlags}` headers.
2. For each non-muted header: `getValueAt(handle, tStart)` → format. One tide
   point query per pill, at module load (not per frame).

---

## 3. Mocked in TS / Zig due to tide gaps (MVP shims)

Each item lists **what** is mocked, **where**, and **why tide can't supply it yet**.

### 3.1 Enum value → label table  *(decision: int in tide, labels in TS)*
- **Where:** `src/renderer/hier/scene.ts` — `ENUM_TYPES` (the `state_t` IDLE/BUSY/WAIT
  table) + an `enumTypeId` overlaid onto the `state` signal node after
  `getHierarchy()`. `native.ts` ships `enumTypes: new Map()` (empty).
- **Why:** tide's hierarchy schema (`hier.zig`'s `SignalPayload`) stores only the
  raw integer width, not enum member tables. The integer *value* is a normal tide
  waveform; only the int→string mapping is mocked.
- **Replace when:** tide hierarchy carries enum member metadata.

### 3.2 Derived signals  *(decision: precomputed waveform in tide)*
- **Where:** `mock_db.zig` stores `busy` / `done` as ordinary signals (rows 12/13)
  with precomputed values (`V_BUSY` = `in_valid | out_valid`, `V_DONE` =
  `state == DONE`). `scene.ts` tags them with a cosmetic `derivedExpr` string and
  `vcdType: "derived"`.
- **Why:** there is no expression engine. The *data* is real (stored in tide); only
  the displayed expression text and the "derived" classification are mocked.
- **Replace when:** a derivation/expression layer computes these live.

### 3.3 Timescale precision + file format
- **Where:** `scene.ts` overlays `timescale.precision = {value:10, unit:"ps"}` and
  `format = "fst"`. `main.zig` `getHierarchy` only emits `{value:1, unit:"ns"}` and
  `format:"fst"`.
- **Why:** tide's mock hierarchy exposes a unit/value but no precision; format is
  unknown for synthetic data.
- **Replace when:** tide surfaces the trace's real timescale precision and source format.

### 3.4 Per-row display config
- **Where:** `scene.ts` `ROWS[]` — radix, color, role (clock/reset/valid), path,
  vcdType, pinned, selected, gateHandle.
- **Why:** presentation/session state, not trace data. (A real app persists this
  per user; it will never come from tide.) `gateHandle` is the one semantic bit —
  it encodes the valid/data relationship and is consumed by the native packer's
  mute logic.

### 3.5 Navigation-only hierarchy (chrome)
- **Where:** `mock_db.zig` `buildHierarchy` reproduces main's full design tree:
  empty scopes (`des`, `fsm`, `xbar`, `mem_ctrl`, `dma`, `uart`) and nav-only
  signals (`c[10:0]`, `load1[0:8]`, …) under `top.keysched`. These get handles in a
  disjoint space (`1000+`) with **no waveform data** — they're never queried.
- **Why:** so the SignalTree looks like a real design. A real VCD's hierarchy would
  populate this naturally; here it's hand-built in Zig.

### 3.6 The mock waveform values themselves
- **Where:** `mock_db.zig` `V_STATE`, `V_CYCLE`, … and the clock/reset builders.
- **Why:** no VCD/FST parser is wired up yet. This is the top-level mock the whole
  effort exists to eventually replace: **load a file → tide populates the db →
  Riptide renders, no mocks.**

---

## 4. File-by-file change summary

**Native (Zig)**
- `segments.zig` — unchanged pool machinery; made `Bits`, `sameValue`,
  `Scene.pushSegment` `pub` for the tide packer.
- `pack.zig` — **new**: `packQuery` pushes tide transitions into a `Scene`;
  `valueAt` point lookup; added `FLAG_RISING_EDGE_LEFT`.
- `mock_db.zig` — **new**: builds the tide `Database` from `V_*` arrays + the full
  mock hierarchy.
- `hier.zig` — **new**: hierarchy builder (scopes/signals) consumed by `getHierarchy`.
- `main.zig` — merged: pool ArrayBuffer output (`multi/single/rowInfo/x0Pool/x1Pool`)
  + spec parsing + `getHierarchy` + `getValueAt`.
- `mock_scene.zig` — **deleted** (replaced by the tide path).
- `build.zig` / `build.zig.zon` — added the `tide` dependency.

**Renderer (TS)**
- `native.ts` — `getMockSegments(specs)` returns pools too; added `getHierarchy`,
  `getValueAt`, `NativePackSpec`.
- `hier/scene.ts` — **new** (replaces `hier/mock.ts`): tide-backed `SCENE` with the
  TS overlays from §3; `buildPackSpecs`, `RESET_HELD_TICKS`.
- `hier/mock.ts` — **deleted**.
- `gpu/data.ts` — added `unpackSegmentHeaders` (3×u32 → timing/flags).
- `App.tsx` — `MOCK_SCENE → SCENE`; `findSegmentAtTick → getValueAt`; pill labels
  rebuilt from native segments + `getValueAt`; `getMockSegments(buildPackSpecs())`.

---

## 5. Verification

- `pnpm wgsl-check`, `pnpm typecheck`, `pnpm build` — all pass.
- Native data path smoke-tested (`dist/native/riptide.node`):
  - `getMockSegments` returns coherent pools (`RowInfo[2]` → bps 2, segstart 0;
    row-2 first pill flags `0x30002` = row | SHADE | RIGHT_EDGE).
  - `getHierarchy` reproduces the full tree (nav `#1000+`, waves `#0–11`,
    derived `#12/13`).
  - `getValueAt` matches the mock: `state@32 = 0` (IDLE), `out_data@28 = all-X`,
    `dbus@15 = Z`.
