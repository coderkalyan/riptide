# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

Run from repo root:

- `pnpm dev` — build + launch Electron (`@riptide/desktop`).
- `pnpm --filter @riptide/desktop build` — compile main process (tsc) + bundle renderer (esbuild) + copy `index.html` to `dist/renderer`.
- `pnpm --filter @riptide/desktop typecheck` — run both tsconfigs (`tsconfig.json` main, `tsconfig.renderer.json` renderer), no emit.
- `pnpm --filter @riptide/desktop dev:ui` — renderer-only esbuild watch + live-reload server at `http://localhost:5173`. Pair with Electron started under `RIPTIDE_DEV=1` to loadURL the dev server instead of `dist/renderer/index.html`.

No tests, no linter configured.

## Architecture

pnpm workspace. One package: `apps/desktop` (`@riptide/desktop`). Electron app that renders digital waveforms via WebGPU.

**Main process** — `src/main/index.ts`. Enables `enable-unsafe-webgpu` (and Vulkan on Linux), opens BrowserWindow. Loads `http://localhost:5173` when `RIPTIDE_DEV` set, else `dist/renderer/index.html`.

**Renderer** — `src/renderer/index.tsx` → `App.tsx`. React 19. All CSS lives in a `<style>` block inside `src/renderer/index.html` — no separate `.css` files.

**WebGPU pipeline** (`src/renderer/gpu/`):
- `device.ts` — `initGPU(canvas)` sets up adapter/device/ctx; `resizeCanvas` keeps backing store synced with CSS size × DPR.
- `data.ts` — `Segment` shape, mock waveform builders, `packSegments` (5×u32 per segment) and `packViewport` (8×f32 = 32B, multiple of 16 per WebGPU alignment).
- `pipelines/digital.ts` + `digital.wgsl` — one render pipeline module with two variant entry points: `vs_single`/`fs_single` and `vs_multi`/`fs_multi`. Draws triangle-strip rects, 4 verts × N instances. `buildSingleBitPipeline` / `buildMultiBitPipeline` construct variants with separate segment storage buffers. Alpha blending enabled. `App.tsx` splits `MOCK_VALID_DATA_SEGMENTS` by row width before building each pipeline — single-bit rows feed one buffer, multi-bit rows the other.
- `frame.ts` — per-frame: updates each pipeline's viewport uniform, issues one render pass with clear color, binds each pipeline, `draw(4, segmentCount)`.

`App.tsx` runs `requestAnimationFrame` loop. Each frame measures canvas rect + first signal row height from DOM (CSS pixels), passes DPR separately — shaders do the scaling. Active Signal value column is computed CPU-side via `findSegmentAtTick` + `formatSegmentValue` (same LSB/MSB convention as the shader).

## Conventions

- **Split tsconfigs**: main = CommonJS to `dist`, renderer = ESNext + Bundler resolution, no emit.
- **WGSL as text import**: esbuild `--loader:.wgsl=text`; types declared in `gpu/wgsl.d.ts`.
- **CPU/GPU layout must stay in sync**: `Segment` struct = 5×u32 in both TS `packSegments` and WGSL. Viewport = 8×f32 with explicit padding. Touching one side requires updating the other.
- **Segment rowFlags packing**: `[15:0]` row index, `[16]` shade, `[17]` right edge, `[18]` rising edge, `[19]` falling edge, `[20]` mute. Logic values use LSB/MSB pair per bit: `(m,l)` = `(0,0)` 0, `(0,1)` 1, `(1,0)` x, `(1,1)` z.
- **CSS-pixel + DPR contract**: all viewport dims measured in CSS px, DPR passed separately. Preserve when editing rendering math.
- **Mock data is static**: `HARDCODED_SEGMENTS` in `gpu/data.ts` and `ACTIVE_SIGNAL_DEFS` in `App.tsx` are fixtures, not loaded at runtime. No VCD parser yet.
- **Time unit**: ticks = nanoseconds (integer) in mock data (`MOCK_CLOCK_TICK_NS = 5`, `MOCK_END_TICKS = 90`).
