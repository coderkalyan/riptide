# WASM backend port — feasibility evaluation

Status: evaluation only. No port code written. Includes results of a concrete
`wasm32-freestanding` compile check (§2) run against the real `tide` / `tide-vcd`
/ riptide-native sources.

**Goal:** compile the Zig backend (riptide-native + its `tide` / `tide-vcd` deps)
to WebAssembly so the app can run in a browser, *in addition to* the existing
Electron build. Today the backend is a Node-API (napi) addon
(`dist/native/riptide.node`) the renderer loads via `require`.

---

## Verdict

**Highly feasible. Low algorithmic risk.** The compute core (VCD parse → db build
→ query → pack → label → hierarchy) is portable Zig over byte-slices and
allocators. A compile spike got cleanly *through* all of it for wasm — no libc,
threading, filesystem, time, or randomness is needed by the logic. File I/O is
**one line**. The work is at the *boundary* (napi glue), the *bootstrap*
(sync → async), *platform shims* (file open + sidecar persistence), and **two
small, mechanical Zig fix-classes the check surfaced** (§2).

The one correction to the "core compiles unchanged" intuition: the port **does
touch the `tide` dependency** — a handful of `@intCast`s for 32-bit `usize`, and
one error-path edit in `tide-vcd`. Both are trivial and located precisely below.

---

## 1. Background — the current boundary

Native surface (`native/src/main.zig`, ~495 LOC of napi glue) exposes exactly **4
functions** to the renderer (`src/renderer/native.ts`):

| fn | when called | data crossing |
|---|---|---|
| `loadVcd(path)` | once per trace open | in: path string. Heavy: parse + db build |
| `getHierarchy()` | once per trace load | out: all hierarchy nodes (objects) |
| `getMockSegments(specs, qStart, qEnd)` | viewport exits packed range; add/remove/reorder/radix change | in: spec array; out: packed GPU buffers (segments/pools/labels/rowInfo) |
| `getValueAt(handle, tick)` | per active row, per cursor move + hover | in: handle+tick; out: small `{lsb,msb}` word arrays |

Everything behind those 4 functions is pure compute:
`pack.zig` (147) · `segments.zig` (279) · `label.zig` (230) · `hier.zig` (152) ·
all of `tide` · all of `tide-vcd`. The marshaling pattern is napi
`napi_create_arraybuffer` (V8 owns the store) + `memcpy` — because V8's Electron
sandbox rejects external pointers.

What makes this WASM-friendly (confirmed by grep + the §2 check):
- **File I/O = 1 line** — `mock_db.zig:141` `readFileAllocOptions`. The parser
  itself (`tide_vcd.Parser.init(gpa, data)`) takes a **byte slice**, not a path.
- **Zero threading** in the core (no `std.Thread` / atomics / mutex).
- **No SIMD**, no `@Vector`.
- **No time/random** in the hot path (only in standalone bench/fixtures).
- **`node_api.h`** `@cImport` lives *only* in `main.zig`. `tide` / `tide-vcd` /
  the compute files import no C.
- Allocators used (`page_allocator`, `ArenaAllocator`) work on wasm.

---

## 2. Concrete freestanding check — method + results

**Method.** Built a throwaway spike that mirrors `mock_db.load()` with the single
file-read line removed (the post-port "loadBytes" shape: JS hands us the bytes),
plus comptime references forcing wasm codegen of the whole compute layer
(`pack`/`segments`/`label`/`hier`). Wired `tide` + `tide-vcd` as modules
(mirroring their own `addModule` roots) and compiled it as an object for several
targets with `link_libc = false` (default). Compile-only — no runtime.

To reproduce, see the Appendix.

**Results.**

| target | result | blockers surfaced |
|---|---|---|
| native (`ReleaseSafe`) | ✅ builds | — (sanity: the spike is valid) |
| **wasm32-freestanding** `ReleaseSmall`, no libc | ❌ | #1 (32-bit usize) + #2 (debug.print) |
| **wasm32-wasi** `ReleaseSmall` | ❌ | #1 (same usize errors first; #2 would resolve via WASI) |
| **wasm64-freestanding** `ReleaseSmall`, no libc | ❌ | #2 only (#1 vanishes — usize is 64-bit) |

The decisive positive: the compiler got cleanly through `tide_vcd`'s
Parser/scanner/header/string-pool/symbol-table/buffer-ring, `tide`'s
Database/Builder/metadata/page, and riptide's pack/segments/label/hier. The
**only** errors were the two classes below. **No missing libc symbol, no
threading requirement, no filesystem dependency** appeared. The
no-libc/freestanding hypothesis holds.

### Blocker #1 — 32-bit `usize` on wasm32 (mechanical, small)

`tide`'s handle/index types are `enum(u64)`:
- `tide/src/metadata.zig:49` `Signal.Id = enum(u64)`
- `tide/src/metadata.zig:54` `Ref = enum(u64)`
- `tide/src/page.zig:17` `Ref = enum(u64)`

`@intFromEnum(id)` yields a `u64` that is then used directly as a slice index.
That only compiles when `usize` is 64-bit (native / wasm64). On wasm32
`usize` = u32, so the compiler rejects the `u64` index:

```
tide/src/db.zig:90: error: expected type 'usize', found 'u64'
        const signal = db.signals.items[index];
```

(plus the equivalent in `mock_db`'s `widths[sid]` line.)

- **Magnitude: small.** Everything in `tide-vcd` is already `enum(u32)`
  (wasm32-safe). Direct `.items[...]` indexing in `tide` core = 1 site. Realistic
  total is a handful of `@intCast` sites confined to ~3 `tide` files
  (`db.zig`, `page.zig`, `metadata.zig`) + `mock_db.zig`. (The check stops at the
  first errors, so expect a few more to surface iteratively as each is fixed.)
- **Fix:** `@intCast` at the index sites, or a tiny `idx(id)` helper. Touches the
  **`tide` dependency** — so it needs an upstream change, a patch, or a fork.
- **Vanishes entirely on wasm64** (`usize` = u64 → the existing code is already
  correct).

### Blocker #2 — `std.debug.print` on a freestanding error path (freestanding only)

`tide-vcd/src/scanner.zig:119`, in the malformed-input branch of the scanner's
`next()`:

```zig
// TODO: This is an error case, add a diagnostic.
else => {
    std.debug.print("unexpected character: '{c}'\n", .{cur});
    unreachable;
},
```

`std.debug.print` drags in the stderr writer → `std.Io.Threaded` → posix
`getrandom` / `IOV_MAX`, which **don't exist on freestanding wasm**:

```
std/Io/Threaded.zig:2064: error: struct 'posix...' has no member named 'getrandom'
  ... referenced by scanner.zig:119 → parser.zig:65 (next) → loadBytes
```

- **Important:** `std.debug.assert` (used heavily across `tide` / `tide-vcd`) is
  **fine** — it traps via the panic handler and pulls no stderr. *Only*
  `std.debug.print` is the problem. The other prints
  (`tide-vcd/src/header.zig:753–760`) are in a debug-dump helper not on the hot
  path; `main.zig` prints are in standalone exes.
- **Fix:** return `error.UnexpectedChar` instead of `print` + `unreachable`. This
  is also the right robustness fix — today a malformed VCD *crashes* (`unreachable`)
  rather than erroring. Touches the **`tide-vcd` dependency**, one line.
- **Resolves automatically on WASI** (has the posix shims) or by installing a
  freestanding-friendly `std_options.logFn` / panic.

### Other finding — input must be NUL-terminated

`tide_vcd.Parser.init` borrows a `[:0]const u8` (sentinel slice). `mock_db` gets
the sentinel for free from `readFile`. The WASM port must **alloc `len+1` in linear
memory and write a trailing `0`** before calling, then pass `ptr[0..len :0]`.

### Target recommendation

**Primary: `wasm32-freestanding`.** Smallest binary, no WASI shim needed in the
browser, broadest WebGPU/browser support. Cost = both fix-classes (#1 + #2), both
mechanical.

- `wasm32-wasi` — only fix #1; #2 auto-resolves. But needs a JS WASI shim
  (e.g. `@bjorn3/browser_wasi_shim`) and a larger binary. Pick only if avoiding
  the (tiny) `tide-vcd` edit matters.
- `wasm64-freestanding` — only fix #2; #1 vanishes, **and it lifts the 4 GB
  linear-memory cap** (see §7). Tradeoff: memory64 codegen is less mature and
  browser support is newer (Chrome shipped memory64 ~2025; Safari lagging). Keep
  as the **future option for multi-GB traces**, not the first target.

---

## 3. Size of change

**Keep unchanged (the hard logic — ~95% of the Zig):**

| area | LOC | why portable |
|---|---|---|
| `tide-vcd/` parser, scanner, pools, header | ~3.8k | `Parser.init(gpa, data)` takes bytes; all `enum(u32)` |
| `tide/` db, query, page, builder, metadata | ~thousands | pure Zig; needs only the few `@intCast`s of #1 |
| `pack.zig` `segments.zig` `label.zig` `hier.zig` | 808 | pure compute, no fs/thread/time |

**Edit (boundary + bootstrap + the two fix-classes):**

| surface | ~LOC | change |
|---|---|---|
| `tide` (`db`/`page`/`metadata`) | ~handful | blocker #1: `@intCast` at u64-index sites (or wasm64) |
| `tide-vcd/scanner.zig:119` | 1 | blocker #2: return error instead of `print`+`unreachable` |
| `main.zig` napi glue | ~495 → new | replace with a WASM-export shim; drop `node_api.h`; flat-buffer marshal instead of napi object walking. (Keep for Electron if dual-backend.) |
| `mock_db.zig:136–142` | ~5 | split `load(path)` → `loadBytes(data)`; hoist read to JS |
| `build.zig` | ~30 | add a `wasm32-freestanding` artifact with exported fns |
| `native.ts` | ~200–400 | instantiate WASM, manage linear memory, marshal — behind a `Backend` interface |
| `sidecar.ts` | ~100 | `require("fs")` → IndexedDB / OPFS backend |
| `App.tsx` + `main/index.ts` open-vcd | ~30 | ipc dialog → `<input type=file>` / File System Access |
| `runtime.ts` + `scene.ts` bootstrap | ~50 | sync module-load → **async** (await wasm ready before first `getHierarchy`) |
| `package.json` / `build-ui.mjs` | ~30 | wasm build step + copy + serve |

≈ 1–2k LOC touched across ~10 files; **none algorithmic.** Two genuinely fiddly
parts:

1. **Async bootstrap reorder.** Today `require(.node)` is synchronous and
   `scene.ts` builds `SCENE` at module-load (calling `getHierarchy`). WASM
   instantiates async (`instantiateStreaming`). The init chain
   `runtime → scene → store` must become await-aware. Contained, but it ripples
   through bootstrap ordering.
2. **Flat marshaling + a 4th layout to keep in sync.** napi reads JS spec objects
   directly (`parseSpec` / `parseEnums`, ~90 LOC). WASM can't see JS objects — it
   crosses only scalars + a linear-memory `ptr/len`. So specs get serialized to a
   flat buffer on the JS side and decoded Zig-side; `getHierarchy` / `getValueAt`
   returns become flat blobs + offsets that JS decodes. The repo already
   disciplines CPU↔GPU layout sync (`segments.zig` / `digital.wgsl` /
   `labels.wgsl`); this adds a WASM-ABI surface to that contract.

---

## 4. Verifying correctness + performance

The existing harness already covers most of this — migration = point the oracles
at the WASM build and diff.

**Correctness (run both backends, diff):**
1. **seam-B differential** (`tests/differential.test.cjs` + `query_fixture.zig`):
   dumps zig-direct `valueAt` over every transition, replays through the addon,
   diffs **byte-for-byte**. Swap addon → WASM; byte-identical proves `getValueAt`.
2. **`getMockSegments` golden** — same trace+specs+window is deterministic; diff
   the packed buffers (segments/pools/labels/rowInfo) napi-vs-WASM. Must be
   bit-identical.
3. **`getHierarchy` golden** — diff the marshaled hierarchy.
4. **Canvas render parity** (`canvas-test`, deterministic headless render) —
   pixel-diff a WASM-backed frame vs the napi golden. Catches marshaling drift
   end-to-end.

**Performance:**
5. `bench.ts` (`window.__bench`) sweeps `getMockSegments` over zoom levels — run
   napi vs WASM.
6. `loadVcd` time on a *synthesized* big VCD (no large trace is in-repo; synth one
   — `$version`+`$timescale`+`$dumpvars`-all required).
7. Per-frame `valueAt` cost (the perf overlay already stamps it).

**Strategy:** keep both targets building from the one core during migration; every
test runs both and diffs. napi stays the oracle until WASM is bit-identical and
perf is acceptable.

---

## 5. Performance implications

(Estimates — the §2 check was compile-only. Validate with §4 once building.)

| path | vs native napi | why |
|---|---|---|
| `loadVcd` (parse + db build) | **1.5–3× slower** (`ReleaseSafe`); ~1.2–2× (`ReleaseFast` + wasm SIMD) | no auto-SIMD, bounds checks, coarse `memory.grow`. The regression you'll feel — on big traces |
| `getMockSegments` (pack) | mildly slower | O(window), already sub-ms; imperceptible |
| `getValueAt` (chatty, O(rows)/cursor-move) | **≈wash or faster** | napi pays env + handle-scope per created value; WASM is a raw call + memory read |
| GPU upload of packed buffers | **possibly faster** | napi does `memcpy` → V8 ArrayBuffer; WASM can hand a typed-array **view** over linear memory straight to `writeBuffer` (zero-copy) |
| hierarchy return | ≈wash | napi per-node calls vs JS-side decode loop over a flat blob |

Net: interactive paths (cursor, pan/zoom repack, frame) same-or-better.
**Trace load is the headline regression.** Mitigate with `ReleaseFast` for the
wasm build, enable wasm `simd128` + `bulk-memory`, and brotli the `.wasm`.
Web-only extra latency (not WASM's fault): fetching + decompressing the VCD before
parse.

---

## 6. Portability

Big wins, mostly orthogonal to the backend choice but unlocked by it.

- **One artifact, all platforms.** napi needs a per-OS native build
  (linux `.so` / mac `.dylib` / win `.dll`) × arch, each asar-unpacked by
  electron-builder. A single `.wasm` runs everywhere — **this kills the native
  build matrix even if you stayed Electron-only.**
- **Runs in every JS host:** browsers, Node, Deno, Bun, Electron, Tauri webview,
  Workers, WASI runtimes.
- **PWA:** WASM + WebGPU + OPFS/IndexedDB + a service worker = an installable,
  offline waveform viewer; the `.wasm` caches in the SW. Fully feasible.
- **Tauri / future:** Tauri uses the system webview + a Rust backend and **cannot
  load a `.node`**. The WASM web build drops into Tauri's webview with **zero Rust
  glue** — WASM makes the app Tauri-portable for free.
- **WebGPU is the real gate, not the backend.** The renderer is already SolidJS +
  WebGPU (web-native today). Chrome/Edge stable ✓, Safari 18+/26 ✓, Firefox
  shipping 2025+. Linux Chrome sometimes needs flags. This gates the *web target*
  regardless of how the backend ships. Electron's `enable-unsafe-webgpu` flag is
  Electron-only; real browsers don't need it.

---

## 7. Security

WASM is **sandboxed; the napi addon is not.** Today the Electron renderer runs
with `nodeIntegration` on — it `require("fs")`, `require(".node")`, has full Node
privileges. A memory-safety bug in the VCD parser (parsing **untrusted user
files**) is therefore an RCE-class issue with filesystem reach.

In WASM the parser can at worst corrupt **its own linear memory** or DoS (infinite
loop / OOM the tab) — it **cannot escape to the host** unless JS explicitly grants
an import. For a web app where users open arbitrary VCDs, this is the strongest
single argument for the port.

Knock-on: moving the parser to WASM and file I/O to web APIs lets Electron
eventually **drop `nodeIntegration` and enable `contextIsolation`**, hardening the
desktop app too.

Caveats / nuance:
- Zig `ReleaseSafe` already traps (bounds/overflow → panic, not UB) and width caps
  exist (`MAX_VALUE_BYTES`). WASM is defense-in-depth on top, not a substitute —
  keep the checks. (Note blocker #2's `unreachable` on bad input is exactly the
  kind of thing to convert to a graceful error.)
- A `.wasm` blob is harder to audit than JS source → build it **reproducibly** and
  pin the toolchain.
- **Single-threaded WASM needs no COOP/COEP headers** (easy deploy). The moment
  you add threads (SharedArrayBuffer — e.g. to parallelize big-trace parse) you
  take on cross-origin-isolation requirements. Stay single-threaded as long as
  possible.

---

## 8. Downsides / upsides

**Downsides:**
- **4 GB wasm32 linear-memory ceiling.** The whole db + buffers live in one linear
  memory; multi-GB traces won't fit. Needs wasm64/memory64 (newer browser support)
  or server-side streaming. Native has no such cap.
- **Trace load 1.5–3× slower** (§5).
- **Async bootstrap refactor** + a **detached-buffer bug class** (re-grab
  `memory.buffer` after every call that may `grow`; never hold a view across one).
- **New marshaling code** + a 4th layout surface to keep in sync.
- **Touches the `tide` dependency** (blocker #1 casts; #2 edit) — needs upstream
  coordination, a patch, or a fork. Small, but not zero.
- **No browser FS** → sidecar persistence + trace open need web replacements.
  File System Access API is Chromium-only; Firefox/Safari fall back to
  download/upload or OPFS.

**Upsides:**
- One artifact, all platforms — kills the native build matrix.
- Sandboxed (security win for untrusted traces; unlocks Electron hardening).
- Tauri/PWA-ready for free.
- Likely faster GPU-upload (zero-copy views) + faster chatty boundary.
- Forces a clean platform-abstraction seam.
- The compute core compiles for wasm with only mechanical edits — confirmed (§2).

---

## 9. Architecture decision + recommended phasing

**The key call: WASM-everywhere vs dual-backend.**

- **(a) WASM everywhere** (Electron also runs WASM). Simplest — one backend path,
  one binary, no per-OS native build. Cost: Electron loses native parse speed +
  real FS, and inherits the 4 GB cap. Best for maintenance.
- **(b) Dual-backend behind a `Backend` interface.** napi for Electron (max perf,
  real FS, huge traces), WASM for web. Marginal cost is keeping `main.zig`
  (already written) + its build step — the core is shared. Best for desktop perf
  on giant traces.

**Recommendation:** introduce the `Backend` seam in `native.ts` now (cheap, good
regardless); ship WASM as the web backend; defer (a)-vs-(b) to a measurement — if
WASM parse on the biggest realistic trace is acceptable inside Electron, go (a) and
delete the native matrix; if desktop users routinely open multi-GB traces, keep (b).

**Phasing:**
1. Hoist I/O: `load(path)` → `loadBytes(data)`, read in JS. Ship under napi
   unchanged (pure refactor, no behavior change) — verify green.
2. Land the two dependency fixes (blocker #1 `@intCast`s in `tide`; blocker #2
   error-return in `tide-vcd`). Harmless on native; verify green.
3. Add the `Backend` interface in `native.ts`; the current napi path becomes one
   impl.
4. Add the `build.zig` wasm artifact + a `wasm.zig` export shim (flat marshaling).
   Build both.
5. Wire the WASM impl; run differential + canvas + bench **WASM-vs-napi** until
   bit-identical and perf is known.
6. Async bootstrap; web file-open + web sidecar (OPFS/IndexedDB); drop the
   Electron-only bits behind a platform check. PWA manifest optional.

**Alternative worth noting:** server-side — keep Zig native on a server, stream
packed buffers over WS. Dodges the 4 GB cap, slow parse, and download entirely;
handles huge traces; but needs backend infra and loses offline/PWA. Not exclusive
with WASM: WASM for small/medium offline, server fallback for giants.

---

## Appendix — reproduce the §2 check

The check used a throwaway spike (since deleted). To re-run:

1. Create a spike `.zig` in `native/src/` that mirrors `mock_db.load()` with the
   `readFileAllocOptions` line replaced by a `data: [:0]const u8` parameter, plus
   a `comptime { _ = &pack.packSignal; _ = &seg.finalize; ... }` block referencing
   the public fns of `pack`/`segments`/`label`/`hier`, and an
   `export fn spike_load(ptr: [*:0]const u8, len: usize) u32` that calls it.
2. Create a temp `build.zig` outside `native/` that does
   `b.createModule(.{ .root_source_file = .{ .cwd_relative = ".../tide/src/root.zig" } ...})`
   for `tide` and `tide-vcd`, points a root module at the spike, `addImport`s
   both, and `addObject`s it.
3. Build per target:
   - native sanity: `zig build -Doptimize=ReleaseSafe`
   - `zig build -Dtarget=wasm32-freestanding -Doptimize=ReleaseSmall`
   - `zig build -Dtarget=wasm32-wasi -Doptimize=ReleaseSmall`
   - `zig build -Dtarget=wasm64-freestanding -Doptimize=ReleaseSmall`
4. Add `-freference-trace=25` (via a direct `zig build-obj`) to trace what pulls a
   given symbol — that's how blocker #2 was traced to `scanner.zig:119`.

Toolchain at time of check: zig 0.16.0.
