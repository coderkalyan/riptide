# Testing

Three independent harnesses (no linter), all run by `pnpm test` (each self-skips
if its external tool — bash / sway / deno / a display — is missing). Individual
harnesses can still be invoked directly as shown in each section below.

1. **Oracle regression/integration** — drives the deterministic **vcd-tests**
   fixture corpus through tide → the napi addon → the app, asserting values,
   formatting, and structure against a ground-truth answer key. Headless and
   CI-ready. **This is the first section below.**
2. **DOM visual regression** — proves the renderer **chrome** (CSS/Tailwind,
   layout) is a pixel no-op against committed PNG goldens, the WebGPU canvas
   masked. See [DOM visual regression](#dom-visual-regression).
3. **Canvas (GPU) pixel** — proves GPU refactors are visual no-ops against a
   committed golden. See [Canvas (GPU) testing](#canvas-gpu-testing).

`pnpm test --update` regenerates the visual + canvas goldens.

Plus manual verification (`pnpm dev`) and ad-hoc verifiers
(`node tests/gate-split.verify.cjs` — muted-data segment splitting).

---

## Oracle regression / integration testing

Deterministic testing against the **vcd-tests** corpus — independently-generated
VCD fixtures plus a ground-truth answer key (`oracle/<fixture>.json`, computed by
a second parser; all times string-encoded so a JS harness can't lose 64-bit
precision).

- **`tests/`** — the harness you run. Per-suite detail in
  [`tests/README.md`](tests/README.md).
- **`tests/FINDINGS.md`** — the live bug/divergence catalog (what's red and why).

The corpus lives at `$VCD_TESTS_DIR` (default `~/Documents/vcd-tests`); it is not
vendored — point the env var at a checkout and run `make` there to regenerate.

### The seams

```
[VCD] → tide core → │napi│ → Electron/JS → │fmt+pack│ → WebGPU
         seam A      seam B     ...           seam C     seam D
```

| Seam | Question | Driver | Headless? |
|---|---|---|---|
| **A** core | does tide compute the right value/hierarchy? | `zig build test` (`native/src/oracle_test.zig`): `pack.valueAt` vs oracle, in-process | yes (no node) |
| **B** marshalling | does the napi boundary preserve it? | `native.test.cjs` (vs oracle) + `differential.test.cjs` (zig-direct vs through-addon, byte-equal) | yes |
| **C** format/pack | are the displayed string + packed pill right? | `format.test.cjs`: `getMockSegments` labels vs oracle | yes |
| **D** full app | does the real app show it? | `e2e/app.test.cjs`: Electron via playwright-core, value cells vs oracle | needs a display |
| — malformed | does bad input survive? | `malformed.test.cjs` | yes |

**Two seam-B drivers.** `native.test.cjs` checks values against the oracle.
`differential.test.cjs` is oracle-free: it runs the *same* `pack.valueAt` on both
sides of the boundary (a Zig exe, `query-fixture`, dumps the pre-boundary bytes;
the addon replays each through `getValueAt`) and asserts byte-equality — pinning
the boundary itself. It byte-verified **3.2M** samples with zero diffs.

**Localization.** Seam A green + differential green ⟹ any value bug is a *crash*
or a *formatter* bug, never silent core/marshalling corruption.

### Running

```sh
pnpm build               # dist/native/riptide.node (query-fixture exe → native/zig-out/bin)
pnpm test                # build addon, then all harnesses (each self-skips on missing tool)
tests/run.sh seam-a      # the oracle/node suites alone: seam-a | native | format | differential | malformed | e2e
VCD_TESTS_DIR=/path tests/run.sh
```

- The **node suites** (native/format/differential/malformed) are fully headless
  and are the CI core. **Seam A** needs `zig`. **e2e** needs an X display (no
  xvfb bundled — run under a display or `xvfb-run -a node --test
  tests/e2e/app.test.cjs`; `SKIP_E2E=1` opts out; expect WebGPU on a Vulkan
  llvmpipe/SwiftShader fallback in CI).
- **Process isolation is mandatory.** The node suites spawn a worker per fixture
  because the addon `@panic`s/`abort()`s on some inputs (the truncated malformed
  file; `getValueAt`/pack on an `event` signal — see FINDINGS B3/B4; a single
  segment spanning > 2³¹ ticks — the deliberate `pack.zig` GPU tick-range assert,
  hit by `time_long_sparse`; the u32 tick overflow B1 is now fixed). Isolated, a
  crash is reported for one fixture and the rest continue.

### Asserted vs. tracked

Genuine value/structure errors **fail**. Display-style and known-capability
divergences (style-only, x/z-hex, leading-zero pad, unsupported radix, real-skip)
are **counted and printed**, not failed, so they don't drown the signal — each
suite prints a summary. See `tests/FINDINGS.md` for the bug-vs-by-design calls
left open.

### Determinism & CI

- **Deterministic by construction** — fixed corpus, fixed oracles, no wall-clock,
  no RNG. Same inputs → same pass/fail.
- The node suites + seam A run with **no display**. They are **red** until the
  `FINDINGS.md` bugs are fixed — intended; gate CI on "no *new* failures" or pin
  the known-failing set.
- **Not yet covered** (need viewer hooks that don't exist — METHODOLOGY §2 in the
  corpus): decimation/draw-budget, perf/jank, `find_next_edge`, real (`f64`)
  signals, and a structured warning log (which would upgrade the malformed suite
  from "survived" to "diagnosed").

---

## DOM visual regression

Goal: prove that renderer-chrome changes meant to be **visual no-ops** (the
Tailwind migration, CSS refactors, layout tweaks) leave the DOM pixel-identical.
Launches the real built Electron app via **playwright-core**, drives it into a
matrix of UI states, and screenshots the full window with the **WebGPU canvas
masked** (its pixels are GPU-rendered, out of scope, and nondeterministic). Each
shot is compared against a committed golden PNG; any chrome change fails.

### Commands

```
pnpm test                       # part of the full run (skipped without bash + sway)
pnpm test --update              # regenerate these (+ canvas) goldens
bash tests/e2e/run-headless.sh  # run this harness alone; UPDATE_GOLDENS=1 to (re)write goldens
```

- Driver `tests/e2e/visual.test.cjs`; pixel diff `tests/e2e/pngdiff.cjs`; goldens
  in `tests/e2e/golden/`; state seeding in `tests/e2e/seed.cjs`. **Build first**
  (`pnpm build`) so `dist/` is current.
- **Fully headless via nested `sway`** (`run-headless.sh`): spins a throwaway
  wlroots-headless compositor on a virtual output, forces Electron onto that
  nested Wayland display, runs the test, tears it down — nothing touches the real
  desktop. Requires `sway` on PATH (software pixman renderer is fine; the GPU
  canvas is masked). Without `run-headless.sh` the test needs a display like the
  e2e suite.
- **Determinism knobs:** fixed content size per state, `device-scale-factor=1`,
  `fonts.ready` await + settle delay, Playwright `animations:'disabled'` +
  `caret:'hide'`, and the canvas mask. Tolerance via env (`VISUAL_CHANNEL`
  per-channel delta, `VISUAL_RATIO` max differing-pixel fraction) absorbs sub-pixel
  text-AA jitter while still catching real glyph/colour/layout shifts.

---

## Canvas (GPU) testing

Goal: prove that GPU refactors meant to be **visual no-ops** (buffer
consolidation, draw-call reshaping, packing tweaks) produce **pixel-identical**
output. The harness renders the real `src/renderer/gpu/*` modules headlessly to
an offscreen texture and compares the read-back pixels against a checked-in
golden, byte-for-byte.

### Runtime

- **Deno** runs the render (it has native WebGPU; Node 26 does not). On this box
  it uses the AMD GPU via Vulkan/RADV.
- **esbuild** (run under Node) bundles the harness + the gpu modules, resolving
  the `.wgsl` text imports, into `scripts/canvas-test/harness.bundle.mjs` (git-ignored).
- Text/label atlases use `OffscreenCanvas` in the app; Deno has no Canvas 2D, so
  `text.ts` exposes an `atlasFactory` seam (`TextOptions.atlasFactory`). Default
  (app) behavior is unchanged — the harness injects a deterministic procedural
  atlas uploaded via `writeTexture`.

### Commands

```
pnpm test                 # part of the full run (skipped without deno)
pnpm test --update        # (re)generate the golden: scripts/canvas-test/golden/scene.{bin,png}

# run this harness alone (builds the bundle, then drives it under deno):
node scripts/canvas-test/build.mjs
deno run --allow-all scripts/canvas-test/harness.bundle.mjs            # compare to golden, exit 1 on diff
deno run --allow-all scripts/canvas-test/harness.bundle.mjs --update   # regenerate the golden
deno run --allow-all scripts/canvas-test/harness.bundle.mjs --equiv    # self-contained no-op proof (see below)
```

- `scene.bin` (raw RGBA, the comparison source of truth) and `scene.png` (human
  view) are committed. On a `CHECK FAIL` the actual frame is written to
  `/tmp/canvas-check-actual.png` for eyeballing.
- Determinism holds for before/after runs on the same machine/driver — that is
  what no-op proofs need. Cross-machine pixel identity is not guaranteed (and not
  required); regenerate the golden if you change machines.

### Workflow

1. **Visual change** (intended): make it, run `pnpm test --update`, commit the
   new golden alongside the code. The PNG diff in review shows the change.
2. **No-op change** (optimization/refactor): make it, run `pnpm test` (or the
   harness alone). It must `CHECK PASS` against the unchanged golden. If it fails,
   the change wasn't a no-op.

### The scene

`harness.ts` builds one representative frame (768×128, dpr 1, window 0..96 ns):
two single-bit clock rows + one multi-bit bus row (digital single/multi
pipelines), dashed grid + cursor/marker lines, a panel tint + crosshatch
dead-zone (rect pipeline), ruler text (text pipeline), and three flag pills
(cursor + 2 markers). Waveform samples, viewport, and pill positions are
hard-coded fixtures — edit `harness.ts` to extend coverage, then re-`update`.
Value labels (`labels.ts`) are wired but left empty; extend if that path changes.

### `--equiv`: proving a no-op without a baseline checkout

When a refactor changes *how* something is drawn but not the result, `--equiv`
renders both ways within the current build and asserts pixel identity — no git
worktree or API juggling needed. The pill-buffer consolidation
(`pillRects`/`pillText` shared buffer + per-pill `firstInstance` draws, vs the
old one-rect-batch-and-one-text-batch-per-pill) is checked this way: the harness
renders via the production `renderFrame` and via a local per-pill-batch reference
encoder, then diffs. Use the same pattern for future "merge the buffers / reshape
the draws" changes.
