# CLAUDE.md

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
- Native packing (`native/src/segments.zig`) — produces GPU-ready `PackedSegment` (3×u32: `t_start`, `t_end`, `row_flags`), `RowInfo` (4×u32 per row), and shared bit-packed sample pools `x0Pool` / `x1Pool` (LSB / MSB). Per-row `bits_per_sample = nextPow2(bit_width) ≤ 32`; samples never straddle a u32. The shader decodes `(lsb, msb)` per instance via `RowInfo.x0_offset_u32` + `segment_start`.
- `digital.ts` + `digital.wgsl` — one shader module, two variant entry points: `vs_single`/`fs_single` (1-bit waveform line) + `vs_multi`/`fs_multi` (multi-bit pill w/ rounded SDF). Triangle-strip rects, 4 verts × N instances. `buildPipelineFromPacked` builds a variant w/ its own segment storage buffer; both variants share the same `RowInfo` + sample pools (`createSceneBuffers`). Alpha blending on. `App.tsx` consumes `getMockSegments()` from the native addon — single-bit rows feed one segment buffer, multi-bit rows the other.
- `frame.ts` — per-frame: write viewport uniform once, single render pass with clear, draw bg (lines, rects), each digital pipeline, fg (text, lines), top (rects, text). 4 verts × instanceCount per draw.

`App.tsx` runs `requestAnimationFrame`. Canvas + first-row measurements are cached via `ResizeObserver` (no per-frame `getBoundingClientRect`). DPR-only changes (drag between displays) tracked via `matchMedia('(resolution: …dppx)')` — re-armed each fire. Active Signal value column computed CPU-side via `findSegmentAtTick` + `formatSegmentValue` (same LSB/MSB convention as shader).

## Conventions

- **Split tsconfigs**: main = CommonJS to `dist`, renderer = ESNext + Bundler resolution, no emit.
- **WGSL as text import**: esbuild `--loader:.wgsl=text`; types in `gpu/wgsl.d.ts`.
- **CPU/GPU layout must stay in sync**: `PackedSegment` = 3×u32 (`t_start`, `t_end`, `row_flags`) in both Zig (`native/src/segments.zig`) + WGSL `Segment`. `RowInfo` = 4×u32 (`x0_offset_u32`, `x1_offset_u32`, `bits_per_sample`, `segment_start`). Viewport = 12 × 4 B = 48 B (16-aligned): `ticks_per_pixel:f32`, `start_ticks_int:i32`, `start_ticks_frac:f32`, `width:f32`, `height:f32`, `row_height:f32`, `dpr:f32`, `selected_row:i32`, `wave_y_offset:f32`, `dim_mask:u32` (per-row 50%-opacity bitmask, wired to the eye toggle), then 2×f32 pad. `start_ticks` is split int/frac so shader subtraction (`f32(i32(t_start) - start_ticks_int) - start_ticks_frac`) keeps full integer precision for tick values > 2^24. Touch one side = update other (Zig, WGSL, `writeViewportInto`).
- **Segment rowFlags packing**: `[15:0]` row index, `[16]` shade, `[17]` right edge, `[18]` rising edge, `[19]` falling edge, `[20]` mute. Logic values use LSB/MSB pair per bit: `(m,l)` = `(0,0)` 0, `(0,1)` 1, `(1,0)` x, `(1,1)` z. Shader bits 16..23 of `row_flags` are repacked into `VertexData.flags[0..7]` (vs_*); flag bits at higher positions in `VertexData.flags` come from per-sample decoded LSB/MSB and differ between `vs_single` and `vs_multi`.
- **CSS-pixel + DPR contract**: all viewport dims (`width`, `height`, `row_height`, `ticks_per_pixel`) and all vertex/geometry coords fed to shaders are CSS px. Shaders divide by `viewport.width`/`height` (CSS) to get clip space; since the framebuffer is `clientSize × dpr`, the clip→framebuffer step *already* scales by DPR. Therefore **shader size literals (line/border thickness, gaps, corner radius, hatch spacing) are bare CSS px and must NOT be multiplied by `viewport.dpr`** — doing so double-applies DPR (a "1px" stroke becomes `dpr²` device px) and breaks cross-display consistency. The `dpr` uniform field is retained for layout but currently unused by shaders. DPR is applied in exactly one place: `resizeCanvas` (`device.ts`) sizing the backing store. Crispness for text is handled by rendering the glyph atlas at `2×dpr` resolution (`text.ts`), not by scaling cell geometry.
- **Mock data static**: `HARDCODED_SEGMENTS` in `gpu/data.ts` + `ACTIVE_SIGNAL_DEFS` in `App.tsx` are fixtures, not runtime-loaded. No VCD parser yet.
- **Time unit**: ticks = nanoseconds (integer) in mock data (`MOCK_CLOCK_TICK_NS = 5`, `MOCK_END_TICKS = 90`).