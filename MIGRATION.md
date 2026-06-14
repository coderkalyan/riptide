# Tauri + wgpu + tide.rs migration

Working notes for the Electron → Tauri 2 migration on the `tauri` branch.
The plan of record: replace Electron with Tauri 2; render waveforms with wgpu
directly to the tao window surface (transparent webview composites the SolidJS
chrome on top — the official wry wgpu pattern); swap the Zig `../tide` for the
Rust `../tide.rs`; move all render-rate logic (viewport, geometry, packing,
formatting, GPU) into Rust. Packaging (3-OS tauri bundler) is deferred.

## Layout

```
crates/riptide-contract   frozen cross-unit types (GPU layouts, specs, IPC schema)
crates/riptide-core       engine: trace adapter, pack, format, viewport, input,
                          clock, geometry — wasm-clean (no wgpu/tauri/fs)
crates/riptide-render     wgpu pipelines + shaders/ — surface-agnostic
                          (texture-view in, headless-testable)
src-tauri                 app shell, IPC commands, surface glue — native-only
src/renderer/ipc          TS mirror of the contract + invoke/Channel bridge
```

`cfg(target_arch)` may appear ONLY in src-tauri. The TS mirror
(`src/renderer/ipc/types.ts`) must stay in lockstep with `riptide-contract`.

The `tide` dependency is an ABSOLUTE path (`/home/kalyan/Documents/tide.rs/...`)
so isolated git worktrees resolve it; parameterize before CI.

`tauri.conf.json` points `frontendDist` at the committed placeholder
`dist-tauri/` (tauri's codegen embeds it at compile time); `tauri dev` uses the
devUrl (run `pnpm dev:ui` in another terminal). The packaging step later points
it at the real renderer bundle.

## Unit → file ownership

A unit edits ONLY its files (plus its tests). Command registration lives in
`src-tauri/src/main.rs` and is complete — no unit touches it.

| Unit | Owns |
|------|------|
| U1  | `src-tauri/src/{surface,render_loop}.rs`, main.rs setup hook body, tauri.conf window tweaks, §U1 findings below |
| U2  | `riptide-core/src/pack/{mod,cache}.rs` + pack differential tests |
| U3  | `riptide-core/src/format/value.rs` + tests |
| U4  | `riptide-core/src/{viewport,input}.rs` + tests |
| U5  | `riptide-core/src/{format/time,clock,geometry}.rs` + tests |
| U6  | `riptide-render/src/{scene,digital}.rs`, `shaders/digital.wgsl` (the one semantic edit) |
| U7  | `riptide-render/src/{lines,rect}.rs` |
| U8  | `riptide-render/src/{text,labels}.rs` (+ bundled font) |
| U9  | `riptide-core/src/pack/buckets.rs` + tests |
| U10 | `src-tauri/src/{commands_doc,events}.rs`, `state.rs`, `trace.rs::hierarchy_dto` + Engine::load_trace timescale mapping |
| U11 | `src-tauri/src/commands_files.rs`; JS: `hier/sidecar.ts`, `MenuBar.tsx`, `WavesToolbar.tsx` |
| U12 | `riptide-render/src/{frame,colors,timing,capture}.rs` |
| U13 | `src/renderer/tauri/*`, `index.tauri.tsx`, store edits, `ActiveSignal.tsx`/`HoverReadout.tsx`, build-script tauri entry |
| U14 | `src-tauri/src/perf.rs`; JS `perf.ts`, `PerfOverlay.tsx` |
| U15 | integration: `engine.rs` bodies, render_loop wiring, dead-code deletion |

## The X/Z plane convention swap (read before touching values)

- Zig tide (`native/src/mock_db.zig charBit`): `0=(lsb0,msb0)`, `1=(lsb1,msb0)`,
  `x=(lsb0,msb1)`, `z=(lsb1,msb1)`.
- tide.rs (`tide-core/src/logic`): plane-major; projected to 2 planes:
  `0=(p0 0,p1 0)`, `1=(p0 1,p1 0)`, `X=(p0 1,p1 1)`, `Z=(p0 0,p1 1)`.

(p0,p1) feed the GPU pools as (x0,x1). For 0/1 the conventions agree; for
unknown bits **x and z are swapped** (`x0_zig = p0 XOR p1`). Consequences:

1. All Rust formatting/classification uses the tide.rs convention (U3).
2. `digital.wgsl` gets exactly ONE semantic edit: the `F_HATCH_COLOR`
   assignment (z-color pick, line ~223 `select(0u, F_HATCH_COLOR,
   lsb_nonzero)`) flips its predicate (U6). `F_CROSSHATCH`/`F_DRAW_LINE` use
   only the unknown plane — unchanged.
3. Differential tests vs Zig fixtures compare **decoded states / label text**
   wherever x/z appear — never raw plane bytes. 2-state data may compare
   byte-equal.

## Differential-test ground rules

The correctness anchor is parity with the Zig oracle at the seams the existing
`tests/` harness uses (see `tests/run.sh`): packed segment structure, label
text, hierarchy DTO. Fixtures: `native/src/mock.vcd`, the vcd-tests corpus,
`dist/native/query-fixture` output. Known deltas to mark expected-improved,
not expected-equal:

- u64 times: the old `time_u64_extreme` u32-cap panic should now pass.
- Event-type signals: `value_at` must not abort.
- tide.rs `SignalQuery` covering-set semantics (sample at-or-before start).

Keep `format/value.rs` bug-compatible with `label.zig`'s hex nibble grouping
(non-nibble-aligned widths group from the MSB side) so label text stays
byte-equal; file the fix as a post-migration follow-up.

## Verification per unit

`pnpm tauri:check` = clippy -D warnings + cargo test + wgsl-check + typecheck.
Scope to your crates while iterating (`cargo test -p riptide-core` etc.).
Full-app e2e exists only after U15 (integration); the old visual harness is
Electron/CDP-only. U1 additionally runs `pnpm tauri dev` interactively and
records findings below.

## §U1 findings (compositing spike)

- **Threading**: all GTK/handle access happens on the main thread inside the
  Tauri `setup` hook (window lookup, raw-window-handle, `create_surface`). The
  resulting `GfxState` (surface + device + queue + config) is handed to a
  dedicated **render thread** (`render_loop`); wgpu objects are `Send + Sync`
  and the render thread never touches GTK again. Window resize / scale-factor /
  destroy arrive on `window.on_window_event` and are forwarded to the render
  thread through `RenderHandle` (a condvar wake-up) — we don't own tao's GTK
  event loop and must never block it on vsync.
- **Linux compositor**: native Wayland is **NOT viable** — GTK and wgpu would
  both attach buffers to the same `wl_surface`. **Run under XWayland:
  `GDK_BACKEND=x11`.** On X11/XWayland the handle is the GTK Xlib window and
  the transparent webview composites correctly over the wgpu layer.
- **Present pacing**: `PresentMode::Fifo` (vsync, universally supported) + a
  dirty-flag condvar scheme. The render thread sleeps until a command, resize,
  or in-flight viewport animation marks it dirty; a continuously-dirty loop is
  throttled by `get_current_texture()` back-pressure, not spinning.
- **Format**: prefer a non-sRGB surface format (the JS renderer wrote raw bytes
  to a `bgra8unorm` canvas — palette parity wants no implicit sRGB encode).
- **Alpha**: the wgpu layer is the opaque bottom of the stack (the webview is
  the transparent one), so the adapter's default/opaque alpha mode is correct.

## Running the Tauri app (bring-up)

One command (the `beforeDevCommand` auto-starts the Tauri UI dev server at
:5173, building `index.tauri.tsx`):

```
GDK_BACKEND=x11 pnpm tauri dev
```

To auto-load a trace, pass it after `-- --` (boot_info reads the first
positional arg): `GDK_BACKEND=x11 pnpm tauri dev -- -- native/src/mock.vcd`.
Otherwise open one via the File menu. The first `cargo` build of the app takes
a few minutes; subsequent launches are fast.

## U15 integration status

Wired and green (builds, clippy clean, all tests pass): `Engine::frame`
(viewport → repack → geometry), the render thread driving the real
riptide-render pipelines (digital single/multi, lines, rects, text) + scene
buffers, command → engine → wake plumbing, clock-grid resolution.

Deferred follow-ups (functions exist + tested, just unwired):
- **Value-pill label text** — the digital multi pipeline draws the pills; the
  text inside needs the digital segment buffer shared with `LabelRenderer`.
- **Bucket-mode downsampling** (`pack::buckets`) — wire `should_bucket` per row
  into `Engine::frame` and route busy bands into `FrameState.bucket_bands`.
- **Reset crosshatch bands** — the contract `RowSpec` dropped the old
  reset/valid role; re-add it, then feed `clock::reset_high_spans` into
  `FrameState.reset_spans`.
- **Hot-event coalescing** — `events::Coalescer` (tested) to dedupe per-frame
  ViewportChanged/HoverChanged instead of the current direct emit.
- **Packaging** — `tauri.conf.json` `bundle.active` is false; 3-OS bundler
  config is a later step.
