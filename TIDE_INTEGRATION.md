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

---

## 1. Data flow overview

```
 tide.Database (per-signal transition store)
        │  db.query(id, 0, END) → Query{ timestamps[], x0s[], x1s[], type }
        ▼
 native/src/pack.zig  packQuery()         ── per transition ──┐
        │  (x0,x1) byte runs passed straight through           │
        ▼                                                      │
 native/src/segments.zig  Scene.pushSegment()                 │
        │   • PackedSegment{t_start,t_end,row_flags} → multi/single list
        │   • (x0,x1) bytes → words_per_sample words, per-row accumulators
        ▼
 Scene.finalize()  packRow()
        │   • concat each row's word-stride samples → x0_pool / x1_pool (u32 words)
        │   • RowInfo{x0_off,x1_off,words_per_sample,segment_start,flags} per row
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

### 2.2 bytes → u32 words (`segments.zig appendWords`, `main.zig jsWordArray`)
tide stores `bps = type.bytes()` little-endian bytes per sample; the pools (and
the CPU value lookup) work in `u32` words. The single shared transform reads each
sample's byte run into `words_per_sample = ceil(width / 32)` zero-padded words:
```zig
// per word w, per byte b in [0,4): word |= bytes[w*4 + b] << (b*8) (if in range)
```
This is the **only** difference from tide's bytes — the values are identical, just
grouped into u32 containers instead of a flat byte run. There is no longer a
narrowing to a single `u32` (the old `readBits`), so widths > 32 carry in full.

### 2.3 `packQuery` — transitions → segments + samples (`pack.zig`)
Walks the query once. For transition `i`:
- `t_start = timestamps[i]`, `t_end = timestamps[i+1]` (or `end_t` for the last).
- `x0 = x0s[i*bps .. (i+1)*bps]`, `x1 = …` — the per-sample byte runs, passed
  straight to `pushSegment` (no per-transition narrowing).
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
- Pushed via `Scene.pushSegment(target, row, width, t_start, t_end, x0, x1, flags)`.

### 2.4 `Scene.pushSegment` — split timing from value (`segments.zig`)
Appends a lean `PackedSegment{ t_start, t_end, row_flags }` (3×u32 = 12 B) to the
multi or single pipeline list, **and** appends this sample's `words_per_sample`
LSB/MSB words (via `appendWords`) to that row's `lsbs` / `msbs` accumulators.
Asserts each row's segments are contiguous in the pipeline (so a single
`segment_start` index suffices on the GPU); the contiguity check uses the row's
sample `count`, not the word-count of the accumulators.

### 2.5 `finalize` / `packRow` — concatenate the value pools (`segments.zig`)
The pools now mirror tide's per-sample byte run, just word-granular:

| | tide `x0s`/`x1s` | Riptide `x0Pool`/`x1Pool` |
|---|---|---|
| granularity | `bytes_per_sample` **bytes** / sample | `words_per_sample` **u32 words** / sample |
| stride | `8 * type.bytes()` bits | `ceil(width / 32)` words, full width |
| container | flat byte slice per signal | shared `u32` word pools, all rows |

`packRow` is now a plain concatenation — each row's accumulator already holds the
final word-stride stream, so it records the row's starting word offset and
appends:
```
x0_offset_u32 = pool.len   // word offset of this row's run
pool.appendSlice(row.lsbs) // word-stride samples, already packed
```
`RowInfo{ x0_offset_u32, x1_offset_u32, words_per_sample, segment_start, flags }`
records where each row's run starts in the pools and its first instance index.
`flags` (bit 0 = dim) is emitted as 0 by the packer; the renderer sets it later via
`setDimFlags` on the eye toggle (a tiny `writeBuffer`, no repack). There is no
bit-packing, mask, or `nextPow2` anymore (an 8-bit signal uses one full word per
sample rather than 4-per-word — negligible since pools are per-transition).

### 2.6 Shader decode (`digital.wgsl`)
Per instance `ii` of row `r`, OR-folding the sample's `words_per_sample` words:
```
sample_index = ii - RowInfo.segment_start
base = sample_index * words_per_sample
lsb = OR over w in [0,words): x0_pool[x0_offset_u32 + base + w]
msb = OR over w in [0,words): x1_pool[x1_offset_u32 + base + w]
```
The renderer only needs whole-sample non-zeroness (any defined-1 bit / any unknown
bit) to choose line vs. crosshatch and the hatch color, so OR-folding every word
is exact for that purpose and width-agnostic. 1-bit rows (`words_per_sample == 1`)
decode to the single word verbatim, identical to before.

### 2.7 `getValueAt` — CPU point lookup (`pack.zig` / `main.zig`)
Replaces the old JS scan over a segment list. `valueAt(db, id, t)` does
`db.query(id, t, t)`, takes the last (active) sample, and returns its byte runs +
width; `main.zig` packs them into `{ lsb: u32[], msb: u32[] }` word arrays (one
word per 32 bits of width). Used by the active-signal value column, hover readout,
and the multi-bit pill labels. `App.tsx formatSegmentValue` reads the word arrays
per bit/nibble (BigInt for decimal), so widths > 32 format in full.

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
   point query per pill, recomputed alongside each GPU repack (scene build /
   add-from-tree / trace swap), not per frame.

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
  - **GPU width (fixed):** the segment packer, shader, and CPU value lookup now carry
    full-width **word-stride** samples (`words_per_sample = ceil(width / 32)`), so
    rows wider than 32 bits render and format correctly — the old `nextPow2 ≤ 32`
    ceiling and `maskForWidth` panic are gone (see §2.2/§2.5/§2.6). The bundled mock
    view includes a 64-bit `wide_data[63:0]` row to exercise this.
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
- **`end_t` vs initial window.** Native `end_t` is the real trace end (max ingested
  timestamp; the fixture emits a trailing `#90`). But the renderer's *initial* time
  window for a fresh trace still uses the `MOCK_END_TICKS` constant
  (`freshInitial(MOCK_END_TICKS)` in `sidecar.ts`) — fine for the mock, wrong for an
  arbitrary file. *Replace when:* `end_t` is surfaced to the renderer and fed into
  the fresh initial window.
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

This section reflects the VCD-driven update; the §2 pool/pack machinery is unchanged.

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
  comes from the trace.
- `pack.zig`, `segments.zig` — the pool format was later **unified with tide + widened
  past 32 bits**: pools are word-stride (`words_per_sample = ceil(width/32)`), `pushSegment`
  consumes tide's byte runs directly, and `nextPow2`/`maskForWidth`/the dead mock builders
  are gone (see §2.2–§2.7). `getValueAt` returns u32-word arrays. `hier.zig` is unchanged.
  All three still operate on `tide.Database` + `hier.Hierarchy` regardless of source.
- `build.zig` / `build.zig.zon` — `tide_vcd` dependency alongside `tide`.

**Main (Electron)**
- `main/index.ts` — **open path**: `currentVcd` default = bundled mock; `loadTrace`
  does the *initial* window load with `?vcd=<path>`; `ipcMain.handle("riptide:open-vcd")`
  shows the file dialog and **returns the chosen path** (the renderer swaps in place; no
  navigation — `currentVcd` is kept only for bookkeeping).

**Renderer (TS)**
- `runtime.ts` — **new**: reads `?vcd` from the window URL → `VCD_PATH`, derives
  `SIDECAR_PATH` (`<trace>.sidecar.json`).
- `native.ts` — added `loadVcd` to the addon interface; calls `loadVcd(VCD_PATH)` at
  module load (before scene build queries the hierarchy).
- `hier/sidecar.ts` — `sidecarPath()` returns the per-trace `SIDECAR_PATH`. (Sidecar
  format/serialize/resolve is the merged sidecar system.)
- `hier/scene.ts` — `buildScene` takes the loaded sidecar, resolves the active view
  from it (by **path**) or opens **empty** when absent; enum/gate overlay (from `ROWS`)
  is path-tolerant; `derived → package` scope overlay (§3.3). `swapTrace` reassigns the
  `let` exports `SCENE`/`INITIAL`/`SIDECAR` for the in-place trace swap; `makeActiveRef`
  / `packSpecsFor` back add-from-tree.
- `App.tsx` — "Open VCD…" invokes `riptide:open-vcd` via `ipcRenderer`, then swaps the
  trace in place via `resetForTrace` (§3.8). Add-from-tree (`add` → `makeActiveRef`)
  repacks the GPU buffers with `rebindPipeline` (no window reload, no pipeline recompile).

---

## 5. Verification

- `pnpm wgsl-check`, `pnpm typecheck`, `pnpm build` — all pass.
- Native data path end-to-end (built `riptide.node`, real pack specs resolved by path):
  - Hierarchy widths match (`state[1:0]`=2, `cycle_count[7:0]`=8, `out_data[31:0]`=32,
    `wide_data[63:0]`=64, …).
  - `getValueAt` matches the old mock exactly for ≤32-bit rows: `in_data@25 = 0xA3`,
    `state@45 = 2`, `dbus@15 = Z` (lsb/msb all-1), `out_data@45 = 0xDEADBEEF`,
    `cycle_count@0 = X`. `words_per_sample` is 1 for the 32-bit row, so the pool words
    and GPU output are byte-identical to the pre-change bit-packed path.
  - **Wide (>32-bit) row:** `wide_data[63:0]` carries two words/sample.
    `getValueAt@25 = {lsb:[0xcafeb0ba, 0xdeadbeef]}` → `0xDEADBEEFCAFEB0BA`,
    `@55 = 0x0123456789ABCDEF`, `@0/@85 = X` (msb both words all-1); its `RowInfo`
    has `words_per_sample = 2`. `formatSegmentValue` renders the full hex/dec/bin
    (BigInt for decimal) — no 32-bit truncation.
- Open path: launching `electron .` (no args) loads `native/src/mock.vcd` via `?vcd=`,
  resolves `mock.vcd.sidecar.json`, and renders the curated **15-row** view (now incl.
  the wide row). The app boots and builds the full scene (all rows packed, including the
  64-bit signal) **without faulting** — confirming the >32-bit path no longer panics;
  the SignalTree + active list populate in the captured `screenshot.png`. Not fully
  exercised here: a wide-window screenshot of the wave canvas itself (the sandbox GPU
  launch is flaky and the default window crops the wave pane), the interactive dialog,
  and the fresh-file empty state.
