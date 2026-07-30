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

The corpus lives at `$VCD_TESTS_DIR` (default `~/Documents/vcd-tests`); it is not
vendored — point the env var at a checkout and run `make` there to regenerate.

### The seams

```
[VCD] → tide core → │napi│ → Electron/JS → │fmt+pack│ → WebGPU
         seam A      seam B     ...           seam C     seam D
```

| Seam | Question | Driver | Headless? |
|---|---|---|---|
| **A** core | does tide compute the right value/hierarchy? | `cargo test -p riptide-native --test oracle` (`native/tests/oracle.rs`): the value active at each sampled tick vs oracle, in-process | yes (no node) |
| **B** marshalling | does the napi boundary preserve it? | `native.test.cjs` (vs oracle) + `differential.test.cjs` (direct vs through-addon, byte-equal) | yes |
| **C** format/pack | are the displayed string + packed pill right? | `format.test.cjs`: `getMockSegments` labels vs oracle | yes |
| **D** full app | does the real app show it? | `e2e/app.test.cjs`: Electron via playwright-core, value cells vs oracle | needs a display |
| — malformed | does bad input survive? | `malformed.test.cjs` | yes |

**Two seam-B drivers.** `native.test.cjs` checks values against the oracle.
`differential.test.cjs` is oracle-free: it runs the *same* value lookup on both
sides of the boundary (the `query-fixture` binary, built from the addon's own
crate, dumps the pre-boundary bytes; the addon replays each through
`getValueAt`) and asserts byte-equality — pinning the boundary itself. It
byte-verified **3.2M** samples with zero diffs.

**Localization.** Seam A green + differential green ⟹ any value bug is a *crash*
or a *formatter* bug, never silent core/marshalling corruption.

### Running

```sh
pnpm build               # dist/native/riptide.node + the query-fixture binary beside it
pnpm test                # build addon, then all harnesses (each self-skips on missing tool)
tests/run.sh seam-a      # the oracle/node suites alone: seam-a | native | format | differential | malformed | e2e
VCD_TESTS_DIR=/path tests/run.sh
```

- The **node suites** (native/format/differential/malformed) are fully headless
  and are the CI core. **Seam A** needs `cargo`. **e2e** needs an X display (no
  xvfb bundled — run under a display or `xvfb-run -a node --test
  tests/e2e/app.test.cjs`; `SKIP_E2E=1` opts out; expect WebGPU on a Vulkan
  llvmpipe/SwiftShader fallback in CI).
- **Process isolation is still used**, one worker per fixture, though it buys
  less than it did: the addon now reports a bad load as a JS exception instead of
  aborting, so the malformed suite records `threw` where it used to record
  `crashed`. What can still abort the worker is a single segment spanning > 2³¹
  ticks — the deliberate GPU tick-range assert in `pack.rs`, hit by
  `time_long_sparse`. Isolated, that fails one fixture and the rest continue.

### Asserted vs. tracked

Genuine value/structure errors **fail**. Display-style and known-capability
divergences (style-only, x/z-hex, leading-zero pad, unsupported radix, real-skip)
are **counted and printed**, not failed, so they don't drown the signal — each
suite prints a summary.

### Where the pack-spec boundary is covered

`getMockSegments` takes a JS object per row, and the shape the *app* sends is not
the shape a harness naturally writes. A stale field name (`gateHandle`) plus a
missing one (`muteHandle: null`) hid a hard launch regression through a full green
run: seam C sent no `muteHandle` at all, and every e2e smoke launch opened a
fixture with **no sidecar**, so zero rows were active and no spec was ever parsed.
The seeded e2e cases did have active rows but only asserted value cells — which
come from `getValueAt` and stay correct while the canvas is dead behind them.

Both holes are closed, and both matter for any future spec field:

- `tests/lib/format-worker.cjs` sends the literal shape `scene.ts`
  `specsFromActive` builds, explicit nulls included.
- the seeded e2e cases assert the console is clean, so a spec the addon rejects
  fails the suite instead of degrading silently to a blank canvas.

### Determinism & CI

- **Deterministic by construction** — fixed corpus, fixed oracles, no wall-clock,
  no RNG. Same inputs → same pass/fail.
- The node suites + seam A run with **no display**. Two known failures are
  expected — see below; gate CI on "no *new* failures" rather than on green.
- **Not yet covered** (need viewer hooks that don't exist — METHODOLOGY §2 in the
  corpus): decimation/draw-budget, perf/jank, `find_next_edge`, real (`f64`)
  signals, and a structured warning log (which would upgrade the malformed suite
  from "survived" to "diagnosed").

### Known failures

Measured 2026-07-29 on the Rust addon. Seam A is green (6397 samples, 0
failures), as are `native` (26/26), `differential` (27/27), `malformed` (4/4) and
`e2e` (27/27).

- **`format: time_long_sparse`** — by design, and the only failing suite entry.
  The fixture holds one value across a span > 2³¹ ticks, which the GPU segment
  buffer (low-32 tick + i32 shader delta) cannot position, so `pack.rs`'s
  `renderable_span` aborts rather than drawing it at a garbled or negative x.
  Clears when the GPU tick pipeline widens to 64-bit (PERFORMANCE.md).

Two entries cleared with the Rust port: `differential: hier_flat_wide` (the old
Zig comparison exe segfaulted in `std.mem.findSentinel`; the fixture now
byte-verifies), and every `crashed` outcome in the malformed suite — a bad load
is a JS exception now, so all four record `threw` or `loaded`.

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
- **States covered** (`STATES` in the driver): the loaded window at three sizes,
  the idle/no-trace window, an open File menu, a row context menu, the color
  picker, the enum dialog, a tooltip, and `search` — both fuzzy-search boxes
  filled, which pins the tree pruned to its matches (scopes above each hit opened,
  matched characters marked) and the active list's marked/faded rows. `search`
  waits on a highlight appearing before capture, since the tree filter resolves
  off the JS thread.

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
