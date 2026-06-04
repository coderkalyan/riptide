# Tide → Riptide integration (MVP)

This document records how the `tide` waveform database was ported onto Riptide's
pool-based WebGPU renderer, and exactly which pieces are still **mocked** because
tide / tide-vcd / VCD don't yet carry that information.

The end goal: opening a real VCD/FST in tide should feed Riptide directly with
**zero** mocking. Everything in the "Mocked" section below is a temporary shim to
be deleted as the stack grows the missing capabilities.

Branch context: `tide` lives at `../tide`, `tide-vcd` at `../tide-vcd` (siblings of
this repo); `native/build.zig.zon` references them as `../../tide` / `../../tide-vcd`.

> **Update — data comes from a VCD file on disk, opened at runtime.**
> The mock waveform is no longer a set of `V_*` arrays in `mock_db.zig`, and no longer
> `@embedFile`d. The native side reads a VCD *path* (`mock_db.load(path)` → tide-vcd →
> `tide.Database` + mirrored hierarchy), exposed to JS as `loadVcd(path)`. The main
> process picks the trace (the bundled `native/src/mock.vcd` by default, or a
> user-opened file) and carries it to the renderer in the window URL (`?vcd=…`); the
> renderer calls `loadVcd` at startup. The §2 pool/pack machinery is unchanged — only
> the *source* of the db + hierarchy changed (hardcoded Zig → parsed VCD file).
> See §3 for the shims, §3.8 for the open-file flow, §4/§5 for files + verification.

> **Update — packing is viewport-windowed and ephemeral (§2.10).**
> `getMockSegments(specs, qStart, qEnd)` queries tide over the **visible viewport
> ± a margin**, not the whole trace, and is repacked on viewport change (pan/zoom)
> as well as on add/remove/reorder/radix. The old per-signal `pack_cache` is gone
> (it keyed on signal config, useless once the output depends on the window). Cost
> is now **O(visible window)** — add/reorder/pan are sub-millisecond when zoomed in.
> The pack/flag/label logic in §2.3–§2.9 is otherwise unchanged.

---

## 1. Data flow overview

```
 tide.Database (per-signal transition store)
        │  db.query(id, qStart, qEnd) → Query{ timestamps[], x0s[], x1s[], type }
        │  (qStart/qEnd = the visible viewport ± margin — see §2.10; O(window))
        ▼
 native/src/pack.zig  packSignal()        ── per transition ──┐
        │  one PackedSegment header per transition (flags/labels)│
        │  + ps.setSamples(query.x0s, query.x1s)  ── ONE memcpy ─┘
        ▼
 native/src/segments.zig  Scene.pushPackedSignal()
        │   • PackedSegment{t_start,t_end,row_flags} → multi/single list
        │   • (x0,x1) bytes → per-row accumulators (bulk appendSlice, byte stride)
        ▼
 Scene.finalize()  packRow()
        │   • concat each row's byte-stride run → x0_pool / x1_pool (u8, 4B-padded)
        │   • RowInfo{x0_off,x1_off,bytes_per_sample,segment_start,flags} per row
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
- The range query is a **binary-search slice** over sorted timestamps, and it
  prepends the sample active at `start` (same `lo = upperBound(start) - 1`). So
  `getMockSegments` passes the **viewport window** `[qStart, qEnd]` (§2.10) and gets
  back exactly the visible transitions plus the left-edge segment — O(window), and
  the left edge draws from offscreen identically to a full-range pack.

The `(x0, x1)` pair is the standard 4-state encoding: `(0,0)=0`, `(1,0)=1`,
`(0,1)=x`, `(1,1)=z` **per bit** (lsb stream = value bits, msb stream = unknown
bits). This matches Riptide's existing LSB/MSB convention exactly — no remap.

### 2.2 bytes → pool (direct memcpy — `segments.zig setSamples`, `finalize`)
tide stores `bps = type.bytes() = ceil(width / 8)` little-endian bytes per sample and
lays a signal's samples out contiguously (`x0s`/`x1s`, `len·bps` bytes). The GPU pools
now use that **same byte stride — there is no transform**: `PackedSignal.setSamples`
copies tide's whole `query.x0s` / `query.x1s` plane straight into the `PackedSignal` in one
`appendSlice` (memcpy), and `finalize`/`packRow` concatenate each row's byte run into
`x0_pool` / `x1_pool`. The pools are bound as `array<u32>` on the GPU (WGSL has no
byte-storage type), so each pool is padded to a 4-byte multiple and the **shader
byte-addresses it** (§2.6): `pool[bi >> 2] >> ((bi & 3) * 8) & 0xff`. The old
byte→u32-word repack — `appendWords`, `words_per_sample`, the long-gone `readBits` /
`nextPow2` — is **deleted**; the pool now holds tide's bytes verbatim.

> The CPU value path keeps a word-array shape: `getValueAt` → `main.zig jsWordArray`
> still packs tide's bytes into `u32` words for `formatSegmentValue` (§2.7). It's
> independent of the pools, so it is the **sole** remaining byte→word conversion (and
> the only surviving caller of `seg.wordsPerSample`).

### 2.3 `packSignal` — transitions → segment headers + samples (`pack.zig`)
Walks the query once. For transition `i`:
- `t_start = timestamps[i]`, `t_end = timestamps[i+1]` (or `end_t` for the last).
  With a windowed query (§2.10) the *last* in-window segment has no in-slice
  successor, so its `t_end` snaps to `end_t` and its `FLAG_RIGHT_EDGE`/caret are
  off. The §2.10 over-fetch margin keeps that last segment **offscreen**, so the
  *visible* right edge always has a real successor and renders byte-identically.
- `x0 = x0s[i*bps .. (i+1)*bps]`, `x1 = …` — the per-sample byte runs, used only for
  flag computation + the multi-bit label (`pushLabel`). The **sample bytes themselves
  are not copied per-transition** — `setSamples` bulk-copies the whole plane once.
- **Flag computation** (mirrors the old `mock_scene.zig` byte-for-byte so GPU
  output is identical). The few flags that inspect the value only need low bits
  and read the byte run directly: clock `val = x0[0]`; the 1-bit x/z right-edge
  suppression tests `anyNonzero(x1)` of this and the next sample.
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
- Header pushed via `PackedSignal.pushSegment(t_start, t_end, flags)`; the value
  bytes via `PackedSignal.setSamples(query.x0s, query.x1s)` — one memcpy of tide's
  whole byte planes, after the walk (the `i`-th `bps`-byte run lines up with segment `i`).

### 2.4 `pushSegment` / `setSamples` / `pushPackedSignal` — timing vs. value (`segments.zig`)
`PackedSignal.pushSegment` appends a lean `PackedSegment{ t_start, t_end, row_flags }`
(3×u32 = 12 B) to the `PackedSignal`'s segment list — **header only**. `setSamples` then
appends tide's whole `x0s`/`x1s` byte planes to the unit's `lsbs`/`msbs` (one
`appendSlice` each — the single surviving sample copy). The `PackedSignal` is now a
short-lived per-call value (built, placed at a row, freed) — there is no longer a
persistent cache holding it across calls (§2.10). At placement,
`Scene.pushPackedSignal` copies the unit's segments into the multi/single pipeline list
(OR'ing in the row) and bulk-copies its byte run into the row's accumulator
(`appendSlice`, byte stride). It asserts each row is filled by exactly one signal and
that `lsbs.len == count·bytes_per_sample` (guards a double-copy / stride drift), so a
single `segment_start` index suffices on the GPU.

### 2.5 `finalize` / `packRow` — concatenate the value pools (`segments.zig`)
The pools are now **identical in layout to tide's byte planes** — no transform:

| | tide `x0s`/`x1s` | Riptide `x0Pool`/`x1Pool` |
|---|---|---|
| granularity | `bytes_per_sample` **bytes** / sample | `bytes_per_sample` **bytes** / sample |
| stride | `ceil(width / 8)` bytes, full width | `ceil(width / 8)` bytes, full width |
| container | flat byte slice per signal | shared `u8` pools, all rows concatenated |

`packRow` is a plain concatenation — each row's accumulator already holds tide's
byte run, so it records the row's starting **byte** offset and appends:
```
x0_offset = pool.len       // byte offset of this row's run
pool.appendSlice(row.lsbs) // tide's byte-stride samples, verbatim
```
`RowInfo{ x0_offset, x1_offset, bytes_per_sample, segment_start, flags }` records where
each row's run starts and its first instance index. `flags` (bit 0 = dim) is emitted as
0 by the packer; the renderer sets it later via `setDimFlags` on the eye toggle (a tiny
`writeBuffer`, no repack). Each pool is then **padded to a 4-byte multiple** (zeros, one
pad per pool) so `writeBuffer` accepts it and the `array<u32>` binding can address the
last sample's word. No bit-packing, mask, `nextPow2`, or word-padding — an 8-bit signal
now uses 1 byte/sample (was a full 4-byte word).

### 2.6 Shader decode (`digital.wgsl`)
The pools are bound as `array<u32>` (WGSL has no byte-storage type), so `decodeSample`
**byte-addresses** them. Per instance `ii` of row `r`, OR-folding the sample's
`bytes_per_sample` bytes:
```
sample_index = ii - RowInfo.segment_start
x0_base = RowInfo.x0_offset + sample_index * bytes_per_sample   // byte offset
lsb = OR over b in [0,bps): (x0_pool[(x0_base+b) >> 2] >> (((x0_base+b) & 3) * 8)) & 0xff
msb = OR over b in [0,bps): (x1_pool[(x1_base+b) >> 2] >> (((x1_base+b) & 3) * 8)) & 0xff
```
The renderer only needs whole-sample non-zeroness (any defined-1 bit / any unknown bit)
to choose line vs. crosshatch and the hatch color, so OR-folding every byte is exact for
that purpose and width-agnostic. The per-byte `& 0xff` makes a read that spills into a
neighbouring sample's word (when `bps` isn't a multiple of 4) inert, so no per-sample
padding is needed. 1-bit rows (`bytes_per_sample == 1`) fold a single byte.

### 2.7 `getValueAt` — CPU point lookup (`pack.zig` / `main.zig`)
Replaces the old JS scan over a segment list. `valueAt(db, id, t)` does
`db.query(id, t, t)`, takes the last (active) sample, and returns its byte runs +
width; `main.zig jsWordArray` packs them into `{ lsb: u32[], msb: u32[] }` word arrays
(one word per 32 bits of width). Used by the active-signal value column + hover readout.
`App.tsx formatSegmentValue` reads the word arrays per bit/nibble (BigInt for decimal),
so widths > 32 format in full. This path is **independent of the GPU pools** (its own
`db.query`) and is the only place that still converts tide's bytes to u32 words
(`seg.wordsPerSample`) — the pools no longer do (§2.2).

### 2.8 napi ArrayBuffer copy (`main.zig`)
V8's sandbox in Electron rejects external pointers, so every buffer is allocated
with `napi_create_arraybuffer` (V8 owns the store) and the packed bytes are
`@memcpy`'d in. Applies to segments (`packSegmentsInto`), `RowInfo`
(`packRowInfosInto`), and the byte pools (`makeArrayBufferFromU8s`, `x0Pool`/`x1Pool`).

### 2.9 Multi-bit pill labels (`App.tsx`)
The value text drawn inside each multi-bit pill no longer comes from a JS segment
carrying its value (segments are valueless now). Instead:
1. `unpackSegmentHeaders(NATIVE.multi, count)` → `{tStart, tEnd, rowFlags}` headers.
2. For each non-muted header: `getValueAt(handle, tStart)` → format. One tide
   point query per pill, recomputed alongside each GPU repack (scene build /
   add-from-tree / trace swap / **viewport pan-zoom**, §2.10), not per frame.
   Since the pills are now windowed too, only the visible pills are formatted.

> Native pill labels (`label.zig formatValue`, packed in lockstep with the
> segments and returned as `labelBytes`/`labelOffsets`) are the GPU path and are
> likewise windowed; the `getValueAt` route above feeds the active-signal value
> column + hover readout, not the on-canvas pills.

### 2.10 Viewport-windowed packing (`main.zig` + `App.tsx`)
Packing is **ephemeral and viewport-scoped**. `getMockSegments(specs, qStart, qEnd)`
queries each signal over the **visible window plus an over-fetch margin** instead of
`[0, end_t]`, and the result is repacked whenever the viewport or active set changes.
This makes add/remove/reorder/radix **and** pan/zoom all O(visible window) — sub-ms
when zoomed in (the win scales with how little is on screen; zoomed-out is slower,
moving more data to the GPU, by design — no CPU downsampling yet).

- **Single packer in the rAF loop.** `App.tsx`'s frame loop owns the repack
  decision. The active-set effect just flips `specsDirtyRef`; the loop computes
  `[qStart, qEnd] = visible ± one screen` and calls `rebuildScene(active, qStart,
  qEnd)` (the same `createSceneBuffers`→`rebindPipeline`→destroy-old machinery,
  synchronous, no pipeline recompile). One path for add/reorder/pan/zoom/swap.
- **Repack triggers (hysteresis).** Only when: the active set changed; the visible
  range crossed **halfway into** the margin at either packed edge (so a small
  back-and-forth pan across a boundary doesn't thrash); a **zoom-out** widened the
  view past `ZOOM_OUT_FACTOR×` the packed density; or a **zoom-in** left the packed
  window more than `WINDOW_SHRINK_FACTOR×` wider than the visible span (keeps GPU
  data O(viewport) instead of growing unbounded from a full-range pack). Pan and
  zoom-in *within* the margin stay pure viewport-uniform updates — the shader
  transforms the already-packed segments, exactly as before this change.
- **Correctness.** tide's range query already returns the left-edge sample
  (§2.1), so the left edge is free; the margin keeps the visible right edge interior
  so its `t_end`/caret/edge match a full pack (§2.3). Output is **visually identical**
  to the old whole-trace pack for the on-screen region.
- **No `pack_cache`.** The old per-signal cache (keyed on signal config, not row or
  window) is removed — viewport-dependent output never reuses across pans. Each
  repack queries + packs the active signals fresh over the window; `PackedSignal`s
  are short-lived (§2.4).
- **`end_t` surfaced.** `getMockSegments`'s return and `getHierarchy()` now carry the
  trace's true `end_t` as `endTicks`; the renderer's `TRACE_END` (`scene.ts`,
  replacing the hardcoded `MOCK_END_TICKS` at the viewport sites) drives the fit
  window, viewport clamps, and the zoom-out dead-zone (§3.8).

---

## 3. Mocked in TS / Zig due to tide gaps (MVP shims)

Each item lists **what** is mocked, **where**, and **why tide can't supply it yet**.

### 3.1 Enum value → label table  *(decision: int in the trace, labels in TS)*
- **Where:** `src/renderer/hier/scene.ts` — `ENUM_TYPES` (the `state_t` IDLE/BUSY/WAIT
  table) + an `enumTypeId` overlaid onto the `state[1:0]` signal node (resolved by
  path) after `getHierarchy()`. `native.ts` ships `enumTypes: new Map()` (empty).
- **Why:** neither VCD nor tide carry an int→label table — only the raw integer
  value (a normal tide waveform). Only the mapping is mocked.
- **Replace when:** enum tables are encoded in the VCD (`$comment`/translate file)
  or tide's hierarchy carries enum member metadata.

### 3.2 Derived signals  *(decision: precomputed waveform in the VCD)*
- **Where:** the VCD declares `busy` / `done` as ordinary signals under a `derived`
  scope, with values precomputed by the generator (`busy = in_valid | out_valid`,
  `done = state == DONE`). `scene.ts` tags them with a cosmetic `derivedExpr` string
  and `vcdType: "derived"`.
- **Why:** there is no expression engine. The *data* is real (in the trace); only the
  displayed expression text and the "derived" classification are mocked.
- **Replace when:** a derivation/expression layer computes these live from inputs.

### 3.3 `package` scope kind
- **Where:** `scene.ts` overlays `scopeType = "package"` onto the `derived` root scope
  after `getHierarchy()`.
- **Why:** tide-vcd's `Scope.Type` has only `begin/fork/function/module/task`, and VCD
  has no `package` scope, so the fixture declares `derived` as a `module`. The overlay
  restores the prior tree styling.
- **Replace when:** tide-vcd grows more scope kinds (or a VCD extension carries it).

### 3.4 Timescale precision
- **Where:** `scene.ts` overlays `timescale.precision = {value:10, unit:"ps"}`;
  `main.zig` `getHierarchy` emits only `{value:1, unit:"ns"}`.
- **Why:** tide-vcd carries the timescale number/unit but no precision.
- **Replace when:** the real timescale precision is threaded through.
- *(The unused `format` field — formerly overlaid as `"fst"` — was removed; it was
  write-only metadata never surfaced in the UI.)*

### 3.5 Value decode: widths, extended logic, real/string
- **Where:** `mock_db.zig` value decode (`charBit` / `appendScalar` / `appendVector`).
- **Signal width:** values are decoded straight into width-sized byte planes (1 bit
  per signal bit, LSB-first), so the **database stores signals of any width** — real
  traces have 64-bit and wider buses (this one has up to 630-bit). Vectors beyond
  `MAX_VALUE_BYTES` (1024 B ≈ 8192 bits) are rejected rather than overflowing.
  - **GPU width (fixed):** the GPU pools carry full-width **byte-stride** samples
    (`bytes_per_sample = ceil(width / 8)` — tide's native stride, memcpy'd; the CPU
    value lookup keeps its own `words_per_sample` u32 packing), so rows of any width
    render and format correctly — the old `nextPow2 ≤ 32` ceiling and `maskForWidth`
    panic are gone (see §2.2/§2.5/§2.6). The bundled mock view includes a 64-bit
    `wide_data[63:0]` row to exercise this.
- **Extended logic / real / string:** scalar `h l u w -` collapse to `x`;
  `real`/`string` value changes are skipped (tide is quaternary-only). Short VCD
  vectors are left-extended to the declared width (correct VCD behavior).
- **Replace when:** tide gains real/string + weak/pull state.

### 3.6 Per-row display config
- **Where:** the live active-signal list (radix, color, role, pinned, selected, …)
  now comes from the **sidecar** (`view.signals`, §3.8), resolved by path in
  `buildScene`. `scene.ts` `ROWS[]` is no longer the active-list source — it survives
  as a path-keyed **overlay table** from which only `gatePath` (→ `GATE_BY_PATH`) and
  `enumTypeId` are still consumed; its radix/color/role/etc. fields are vestigial
  (the sidecar carries them). `makeActiveRef` supplies defaults for a signal added
  from the tree (bus → hex, scalar → bin, palette color cycled by row).
- **Why:** presentation/session state, not trace data (a real app persists this per
  user; it never comes from the trace). Each row binds to its signal by **path**; the
  tide handle is resolved from the loaded hierarchy at scene-build time (tide-vcd
  assigns ids in declaration order, so handles can't be hardcoded). `gatePath` is the
  one semantic bit — it encodes the valid/data relationship consumed by the native
  packer's mute logic, applied by path whether the active list comes from a sidecar
  or an add-from-tree.

### 3.7 Navigation-only hierarchy (chrome)
- **Where:** the VCD fixture declares extra signals/scopes beyond the 14 rendered
  rows: nav wires under `top.keysched` (`c[10:0]`, `load1[0:8]`, …) and extra signals
  under `top.keysched.{fsm,xbar}` and `top.{mem_ctrl,dma,uart}`. They carry simple
  representative waveforms and are addable to the wave view.
- **Why:** so the SignalTree looks like a realistic design. With a real VCD this comes
  for free; here the generator synthesizes it.

### 3.8 Open-file flow + sidecar (wired)
The "Open VCD…" path is now live and swaps the trace **in place — no window
reload**. **File → Open VCD…** → `ipcRenderer.invoke("riptide:open-vcd")` → main
shows a native dialog and **returns the chosen path** (no navigation). The renderer
then calls `App.resetForTrace(path)` → `scene.ts swapTrace`: native `loadVcd` (swap
the cached db on success, throw and keep the prior trace on a bad file) → reload the
sidecar → rebuild `SCENE`/`INITIAL`. Those are `let` exports, so ES live bindings
hand the new values to every import site; `resetForTrace` then re-seeds all React
state + refs and forces a synchronous GPU repack (`rebuildSceneRef`), so the App
stays mounted (device + pipelines + rAF loop persist, no GPU re-init). The initial
load on launch still goes through the window URL (`?vcd=`, `main/index.ts loadTrace`).

Presentation state lives in a **per-trace sidecar** (`<trace>.sidecar.json`, see
`docs/sidecar.md`):
- **Bundled mock** ships `native/src/mock.vcd.sidecar.json`, so opening it restores
  the curated 15-row view (signals, colors, radices, roles, derived labels, tree
  expansion — incl. the 64-bit `wide_data` row). Enum mapping + gating are applied
  trace-side by path (§3.1/§3.6), independent of the sidecar.
- **A fresh/arbitrary VCD** has no sidecar → opens with **nothing active** (the
  SignalTree populates; the wave view is empty). **Add-from-tree is now wired**:
  clicking a tree signal appends an `ActiveSignalRef` (`makeActiveRef`) and repacks
  the GPU buffers via `packSpecsFor` + `rebindPipeline` (synchronous, no recompile),
  and the sidecar auto-saves the resulting view.

Still mocked / rough here:
- **`end_t` vs initial window — resolved (§2.10).** Native `end_t` (the real trace
  end; the fixture emits a trailing `#90`) is now surfaced to the renderer via
  `getHierarchy().endTicks` and exported as `TRACE_END` (`scene.ts`). The fresh
  initial window uses it (`freshInitial(TRACE_END)`), as do every viewport clamp,
  the auto-fit, and the zoom-out dead-zone — the hardcoded `MOCK_END_TICKS` is gone
  from the viewport sites (it survives only as the clock-grid period constant). So a
  fresh arbitrary VCD now fits to its real length, not 90.
- **Default trace path** is `app.getAppPath()/native/src/mock.vcd` — correct under
  `electron .`; a packaged build would need the fixture shipped + path adjusted.

### 3.9 Upstream tide-vcd changes
- **`root.zig` exports** — `Parser`/`Hierarchy`/`Header`/`SignalId` were not
  `pub`-exported (the re-exports were private, used only by tests), so the package
  wasn't consumable. Made them public.
- **`symbol_table.zig` fast-path bug fix** — `fastCode` mapped 2-byte id codes led
  by `'!'` (value 0) into the same `[0,94)` slot range as 1-byte codes, so e.g.
  `"!%"` aliased `"%"` → one `SignalId` for two distinct signals. Harmless for the
  ≤94-signal mock (1-byte codes only) but corrupts any real trace with ≥95 signals
  (which need 2-byte codes) — it surfaced as a panic opening
  `warp_hart_tb.vcd` (1100+ signals): a 1-bit signal's scalar change landed on a
  32-bit signal's builder. Fixed by offsetting 2-byte codes past the 1-byte range;
  added a regression test.

### 3.10 u32 tick ceiling  *(known limitation, accepted)*
- **Where:** the GPU tick path narrows tide's `u64` timestamps to `u32` at the
  native boundary — `pack.zig` (`t_start`/`t_end`), `main.zig`/`mock_db.zig`
  (`end_t`). The shader's `start_ticks` int/frac split preserves precision for the
  *f32* math, but storage and the napi boundary are u32-capped.
- **Behavior:** all sites use the **checked** `@intCast` and the native build is
  `-Doptimize=ReleaseSafe`, so a trace exceeding 2³² ticks **panics** ("integer
  cast truncated bits") rather than silently wrapping/corrupting. `pack.zig` adds
  an explicit `std.debug.assert(ts <= maxInt(u32))` so the failure is legible.
- **Replace when:** large real traces (long runs in ps/fs) land — widen the GPU
  tick path to u64 (or rebase ticks to the view window). Accepted as-is for now.

---

## 4. File-by-file change summary

This section reflects the VCD-driven update plus the **viewport-windowed packing**
migration (§2.10); the §2 pool/pack *bit layout* is unchanged — only the query range
(whole-trace → window) and the cache (removed) changed.

**Native (Zig)**
- `mock.vcd` — fixture: the mock scene (hierarchy + waveforms), generated by
  `scripts/gen_mock_vcd.py`. Var references are written fused (`state[1:0]`) since
  tide-vcd keeps the reference token and drops a separate bit-range token.
- `mock.vcd.sidecar.json` — **new**: the curated view for the bundled mock (so opening
  it restores the 15-row layout, incl. the 64-bit `wide_data` row). A fresh trace has no
  sidecar (§3.8).
- `mock_db.zig` — `load(path)` reads the VCD from disk (Zig 0.16 `Io` API), parses with
  tide-vcd, mirrors the hierarchy into `hier.Builder`, and streams value-change events
  into per-signal `tide.Builder`s → one `tide.Database`. Holds the value-decode bridge
  (`charBits`/`decodeVector`/`writeBits`) and returns `Loaded{db, hierarchy, end_t}`.
  No more `@embedFile`.
- `main.zig` — `loadVcd(path)` napi: (re)builds the cached scene, swap-on-success,
  throws a JS error on a bad file. `getLoaded`/`getDb`/`getHier` read the cache; `end_t`
  comes from the trace. **Windowing (§2.10):** `getMockSegments(specs, qStart, qEnd)`
  takes the viewport window and queries `db.query(handle, qStart, qEnd)` (was `0,
  end_t`); the per-signal `pack_cache` + `PackKey`/`hashEnums` are **deleted** (packs
  are viewport-dependent now). `getHierarchy` and `getMockSegments` both return the
  trace's `endTicks` (= `end_t`) so the renderer can drop its hardcoded end.
- `pack.zig`, `segments.zig` — the pool format was later **unified with tide's byte
  layout**: pools are byte-stride (`bytes_per_sample = ceil(width/8)`, tide's native
  stride), `packSignal` bulk-`memcpy`s tide's whole byte planes (`setSamples`) with no
  per-sample repack, and `appendWords`/`nextPow2`/`maskForWidth`/the dead mock builders
  are gone (see §2.2–§2.7). `getValueAt` still returns u32-word arrays (its own path).
  `hier.zig` is unchanged. All operate on `tide.Database` + `hier.Hierarchy` regardless
  of source.
- `build.zig` / `build.zig.zon` — `tide_vcd` dependency alongside `tide`.

**Main (Electron)**
- `main/index.ts` — **open path**: `currentVcd` default = bundled mock; `loadTrace`
  does the *initial* window load with `?vcd=<path>`; `ipcMain.handle("riptide:open-vcd")`
  shows the file dialog and **returns the chosen path** (the renderer swaps in place; no
  navigation — `currentVcd` is kept only for bookkeeping).

**Renderer (TS)**
- `runtime.ts` — **new**: reads `?vcd` from the window URL → `VCD_PATH`, derives
  `SIDECAR_PATH` (`<trace>.sidecar.json`). Also exports `BENCH` (`?bench=1`) for the
  pack-cost harness.
- `native.ts` — added `loadVcd` to the addon interface; calls `loadVcd(VCD_PATH)` at
  module load (before scene build queries the hierarchy). `getMockSegments(specs,
  qStart, qEnd)` now takes the window and surfaces `endTicks`; `getHierarchy()`
  marshals `endTicks` onto the `Hierarchy`.
- `hier/types.ts`, `hier/hierarchy.ts` — `Hierarchy` gains `endTicks` (native trace
  end); the `HierarchyBuilder` carries it via `setEndTicks` (defaults 0).
- `hier/sidecar.ts` — `sidecarPath()` returns the per-trace `SIDECAR_PATH`. (Sidecar
  format/serialize/resolve is the merged sidecar system.)
- `hier/scene.ts` — `buildScene` takes the loaded sidecar, resolves the active view
  from it (by **path**) or opens **empty** when absent; enum/gate overlay (from `ROWS`)
  is path-tolerant; `derived → package` scope overlay (§3.3). `swapTrace` reassigns the
  `let` exports `SCENE`/`INITIAL`/`SIDECAR` for the in-place trace swap; `makeActiveRef`
  / `packSpecsFor` back add-from-tree. **Exports `TRACE_END`** (`= SCENE.hierarchy.
  endTicks`, reassigned in `swapTrace`) — the live source of truth for the fit window /
  clamps / dead-zone (replaces `MOCK_END_TICKS` at the viewport sites, §2.10/§3.8).
- `App.tsx` — "Open VCD…" invokes `riptide:open-vcd` via `ipcRenderer`, then swaps the
  trace in place via `resetForTrace` (§3.8). **Viewport-windowed packing (§2.10):** the
  rAF loop is the single packer — it computes `[qStart, qEnd]` from the viewport and
  calls the (now range-taking) `rebuildScene`; the active-set effect only flips
  `specsDirtyRef`. Repack triggers use margin hysteresis + `ZOOM_OUT_FACTOR` /
  `WINDOW_SHRINK_FACTOR`. `MOCK_END_TICKS` at the viewport sites → `TRACE_END`.
- `bench.ts` — **new**: installs `window.__bench({startTicks?, tppList?, iters?})`
  (announced by `?bench=1`), sweeps `getMockSegments` pack ms + bytes-to-GPU across
  zoom levels for the before/after comparison. `perf.ts` exports `percentile` for it.

---

## 5. Verification

- `pnpm wgsl-check`, `pnpm typecheck`, `pnpm build` — all pass.
- Native data path end-to-end (built `riptide.node`, real pack specs resolved by path):
  - Hierarchy widths match (`state[1:0]`=2, `cycle_count[7:0]`=8, `out_data[31:0]`=32,
    `wide_data[63:0]`=64, …).
  - `getValueAt` matches the old mock exactly for ≤32-bit rows: `in_data@25 = 0xA3`,
    `state@45 = 2`, `dbus@15 = Z` (lsb/msb all-1), `out_data@45 = 0xDEADBEEF`,
    `cycle_count@0 = X`. `bytes_per_sample` is 4 for the 32-bit row.
  - **Wide (>32-bit) row:** `wide_data[63:0]` carries 8 bytes/sample.
    `getValueAt@25 = {lsb:[0xcafeb0ba, 0xdeadbeef]}` → `0xDEADBEEFCAFEB0BA`,
    `@55 = 0x0123456789ABCDEF`, `@0/@85 = X` (msb both words all-1); its `RowInfo`
    has `bytes_per_sample = 8`. `formatSegmentValue` renders the full hex/dec/bin
    (BigInt for decimal) — no 32-bit truncation.
  - **Byte-stride pool migration (§2.2):** a deterministic harness packs the curated
    rows (widths 1/2/8/16/32/64) and asserts, for every sampled transition, that the
    `x0Pool`/`x1Pool` bytes at `RowInfo.x0_offset + sample·bytes_per_sample` equal the
    little-endian value bytes from `getValueAt` (the independent word path), that
    `bytes_per_sample == ceil(width/8)`, and that each pool length is a 4-byte multiple
    — i.e. the pools now hold tide's bytes verbatim with no repack. The Stage-2 bulk
    `setSamples` memcpy produces byte-identical pools to the Stage-1 per-sample copy.
- **Viewport-windowed packing (§2.10):** native windowing validated headlessly
  (`require("dist/native/riptide.node")` under plain node) — `endTicks` exposed,
  and segment/byte counts scale linearly with the window (full mock 1860 B/155 segs
  → 1/10-window 588 B/49 segs → tiny 456 B/38 segs). Before/after on a synthetic
  300k-tick, 4-signal trace (full-range = the old always-full pack vs windowed):

  | case | window (ticks) | segments | KiB→GPU | pack ms |
  |---|---|---|---|---|
  | BEFORE full-range | 299,999 | 487,502 | 7544 | 27.9 |
  | AFTER 1/100 zoom | 9,000 | 14,629 | 226 | 1.1 |
  | AFTER 1/1000 zoom | 900 | 1,467 | 22.7 | 0.28 |

  ≈100× faster pack and ≈330× less GPU data when zoomed in; the old 27.9 ms full
  pack ran on *every* add/reorder, now <0.3 ms. The app boots and renders both the
  mock and the 300k-tick trace for 12 s with **zero** renderer console errors (the
  per-frame repack path runs clean). Not exercised headlessly: the interactive
  pixel-level A/B vs `main` (zoom/pan, right-screen-edge under pan, sparse pills),
  the margin-boundary no-thrash check (`?perf=1`), and `window.__bench` in DevTools.
- Open path: launching `electron .` (no args) loads `native/src/mock.vcd` via `?vcd=`,
  resolves `mock.vcd.sidecar.json`, and renders the curated **15-row** view (now incl.
  the wide row). The app boots and builds the full scene (all rows packed, including the
  64-bit signal) **without faulting** — confirming the >32-bit path no longer panics;
  the SignalTree + active list populate in the captured `screenshot.png`. Not fully
  exercised here: a wide-window screenshot of the wave canvas itself (the sandbox GPU
  launch is flaky and the default window crops the wave pane), the interactive dialog,
  and the fresh-file empty state.
