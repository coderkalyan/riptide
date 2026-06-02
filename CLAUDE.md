# CLAUDE.md

Read and follow @~/.config/agents/AGENTS.md.

File guide Claude Code (claude.ai/code) for repo work.

## Commands

Run from repo root:

- `pnpm wgsl-check` — validate all `.wgsl` files via `naga --bulk-validate`. Runs before build + `dev:ui`.
- `pnpm build` — wgsl-check + compile main process (tsc) + bundle renderer (esbuild) + copy `index.html` to `dist/renderer`.
- `pnpm dev` — build + launch Electron.
- `pnpm dev:ui` — wgsl-check + renderer-only esbuild watch + live-reload server at `http://localhost:5173`. Pair with Electron started under `RIPTIDE_DEV=1` to loadURL dev server instead of `dist/renderer/index.html`.
- `pnpm typecheck` — run both tsconfigs (`tsconfig.json` main, `tsconfig.renderer.json` renderer), no emit.

Requires `naga` CLI on PATH (`cargo install naga-cli`). No tests, no linter.

## Architecture

Single-package repo at root (`riptide`). Electron app render digital waveforms via WebGPU.

**Main process** — `src/main/index.ts`. Enable `enable-unsafe-webgpu` (+ Vulkan on Linux), open BrowserWindow. Load `http://localhost:5173` when `RIPTIDE_DEV` set, else `dist/renderer/index.html`.

**Renderer** — `src/renderer/index.tsx` → `App.tsx`. React 19. All CSS in `<style>` block inside `src/renderer/index.html` — no separate `.css` files.

**WebGPU pipeline** (`src/renderer/gpu/`):

- `device.ts` — `initGPU(canvas)` set up adapter/device/ctx; `resizeCanvas` sync backing store with CSS size × DPR.
- `data.ts` — TS `Segment` shape, mock waveform builders, viewport packing (`writeViewportInto`, 12×4 B = 48 B uniform — see Conventions below).
- Native packing (`native/src/segments.zig`) — produces GPU-ready `PackedSegment` (3×u32: `t_start`, `t_end`, `row_flags`), `RowInfo` (4×u32 per row), and shared word-stride sample pools `x0Pool` / `x1Pool` (LSB / MSB). Per-row `words_per_sample = ceil(bit_width / 32)`: each sample is that many consecutive u32 words (full declared width, little-endian, zero-padded — the same layout as tide's per-sample byte run, just word-granular), so signals wider than 32 bits are carried in full. The shader decodes `(lsb, msb)` per instance via `RowInfo.x0_offset_u32` + `segment_start`, OR-folding the words (it only needs whole-sample non-zeroness to pick line/crosshatch/color).
- `digital.ts` + `digital.wgsl` — one shader module, two variant entry points: `vs_single`/`fs_single` (1-bit waveform line) + `vs_multi`/`fs_multi` (multi-bit pill w/ rounded SDF). Triangle-strip rects, 4 verts × N instances. `buildPipelineFromPacked` builds a variant w/ its own segment storage buffer; both variants share the same `RowInfo` + sample pools (`createSceneBuffers`). Alpha blending on. `App.tsx` consumes `getMockSegments()` from the native addon — single-bit rows feed one segment buffer, multi-bit rows the other.
- `frame.ts` — per-frame: write viewport uniform once, single render pass with clear, draw bg (lines, rects), each digital pipeline, fg (text, lines), top (rects, text). 4 verts × instanceCount per draw.

`App.tsx` runs `requestAnimationFrame`. Canvas size (`clientWidth`/`clientHeight`) is read live each frame; row height is the `ROW_HEIGHT_CSS` constant (mirrors the `--row-h` CSS var, so canvas rows line up with the DOM `.s-row`s regardless of row count). `resizeCanvas` syncs the backing store on `ResizeObserver`; DPR-only changes (drag between displays) tracked via `matchMedia('(resolution: …dppx)')` — re-armed each fire. Active Signal value column computed CPU-side via `findSegmentAtTick` + `formatSegmentValue` (same LSB/MSB convention as shader).

**Perf overlay** (`perf.ts`, `gpu/timing.ts`, `PerfOverlay.tsx`): toggle the HUD with the backtick **`` ` ``** key, `?perf=1` in the URL, or `window.__perf.enable()`; `window.__perf.dump()`/`.snapshot()`/`.reset()` from DevTools. Tracks electron (main-thread rAF) present fps + dropped frames + longtask jank, canvas GPU pass ms (WebGPU `timestamp-query`, requested in `device.ts`, fed through `renderFrame`'s optional `GpuTimer`; falls back to n/a when unsupported), CPU encode ms, the VCD-load phase breakdown (module-load `stamp()`s, finalized on first frame), and add-signal latency (click → repack → present). Enable state persists in `sessionStorage` so it survives the Open-VCD reload; frame metering + load stamps are always-on (cheap), GPU queries + overlay only when enabled.

## Conventions

- **Split tsconfigs**: main = CommonJS to `dist`, renderer = ESNext + Bundler resolution, no emit.
- **WGSL as text import**: esbuild `--loader:.wgsl=text`; types in `gpu/wgsl.d.ts`.
- **CPU/GPU layout must stay in sync**: `PackedSegment` = 3×u32 (`t_start`, `t_end`, `row_flags`) in both Zig (`native/src/segments.zig`) + WGSL `Segment`. `RowInfo` = 4×u32 (`x0_offset_u32`, `x1_offset_u32`, `words_per_sample`, `segment_start`). Viewport = 12 × 4 B = 48 B (16-aligned): `ticks_per_pixel:f32`, `start_ticks_int:i32`, `start_ticks_frac:f32`, `width:f32`, `height:f32`, `row_height:f32`, `dpr:f32`, `selected_row:i32`, `wave_y_offset:f32`, `dim_mask:u32` (per-row 50%-opacity bitmask, wired to the eye toggle), then 2×f32 pad. `start_ticks` is split int/frac so shader subtraction (`f32(i32(t_start) - start_ticks_int) - start_ticks_frac`) keeps full integer precision for tick values > 2^24. Touch one side = update other (Zig, WGSL, `writeViewportInto`).
- **Segment rowFlags packing**: `[15:0]` row index, `[16]` shade, `[17]` right edge, `[18]` rising edge, `[19]` falling edge, `[20]` mute. Logic values use LSB/MSB pair per bit: `(m,l)` = `(0,0)` 0, `(0,1)` 1, `(1,0)` x, `(1,1)` z. Shader bits 16..23 of `row_flags` are repacked into `VertexData.flags[0..7]` (vs_*); flag bits at higher positions in `VertexData.flags` come from per-sample decoded LSB/MSB and differ between `vs_single` and `vs_multi`.
- **CSS-pixel + DPR contract**: all viewport dims (`width`, `height`, `row_height`, `ticks_per_pixel`) and all vertex/geometry coords fed to shaders are CSS px. Shaders divide by `viewport.width`/`height` (CSS) to get clip space; since the framebuffer is `clientSize × dpr`, the clip→framebuffer step *already* scales by DPR. Therefore **shader size literals (line/border thickness, gaps, corner radius, hatch spacing) are bare CSS px and must NOT be multiplied by `viewport.dpr`** — doing so double-applies DPR (a "1px" stroke becomes `dpr²` device px) and breaks cross-display consistency. The `dpr` uniform field is retained for layout but currently unused by shaders. DPR is applied in exactly one place: `resizeCanvas` (`device.ts`) sizing the backing store. Crispness for text is handled by rendering the glyph atlas at `2×dpr` resolution (`text.ts`), not by scaling cell geometry.
- **Vertical-line alignment contract**: the ruler is the source of truth for where a line lands. `xForTick(t) = (t - startTicks) / ticksPerPixel` maps a logical time instant to its CSS-px x. `LINE_THICKNESS_CSS` (App.tsx, = `thickness` in `lines.wgsl` — keep in sync) is how far a line extends.
  - **Time-aligned lines** (ruler notches, dashed grid, cursor, markers) are **left-aligned** to their logical time: the line's *left edge* sits on `xForTick(t)` and it extends `THICKNESS` px to the right. `lines.wgsl` left-aligns (`x_px + corner_x * thickness`), so CPU code passes `l.x = xForTick(t)` directly (no half-thickness inset). Notch rects use the same `r.x = xForTick(t)`, `w = LINE_THICKNESS_CSS`.
  - **Segment edges** (multi-bit gap; single-bit right edge / rising-falling caret) are **right-justified** to the segment, drawn *leading up to* the next segment's boundary `xForTick(t_end)`. The segment body is left-aligned to `xForTick(t_start)`, so each segment is itself left-aligned to its logical time. Segments are NOT centered (gaps/edges never straddle the boundary). This is already how `digital.wgsl` packs `pixel_bounds` (`-xgap_px` on the right; `edge_left_x = half - thickness`; caret apex biased `- thickness*0.5`) — no change needed there.
  - Consequence: segment edges deliberately do **not** line up with grid lines — a grid line's left edge starts on the boundary going right, while the segment edge ends on the same boundary coming from the left.
  - **Hover guide** is the one exception: it is **centered** on the pointer. It's still drawn with the left-align shader, but `updateHover` biases its tick left by `LINE_HALF_CSS` px so the left-aligned line renders centered on the pointer pixel. The reported logical time is thus ~½-thickness off the raw pointer pixel. `tickAtClientX` applies the **same** bias, so click-to-place cursor/markers land exactly where the centered hover line sat. Pill anchoring (`addFlag`), marker grab-test center, and span-arrow endpoints all account for the left-edge convention (add `LINE_HALF_CSS` to reach the visual center).
- **Mock data static**: `HARDCODED_SEGMENTS` in `gpu/data.ts` + `ACTIVE_SIGNAL_DEFS` in `App.tsx` are fixtures, not runtime-loaded. No VCD parser yet.
- **Time unit**: ticks = nanoseconds (integer) in mock data (`MOCK_CLOCK_TICK_NS = 5`, `MOCK_END_TICKS = 90`).

