# Testing

Two independent harnesses (no linter):

1. **Oracle regression/integration** — drives the deterministic **vcd-tests**
   fixture corpus through tide → the napi addon → the app, asserting values,
   formatting, and structure against a ground-truth answer key. Headless and
   CI-ready. **This is the section below.**
2. **Canvas (GPU) pixel** — proves GPU refactors are visual no-ops against a
   committed golden. See [Canvas (GPU) testing](#canvas-gpu-testing).

Plus manual verification (`pnpm dev`).

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
pnpm build:native        # dist/native/riptide.node + the query-fixture exe
pnpm test                # == tests/run.sh: all suites (e2e only if $DISPLAY set)
tests/run.sh seam-a      # one suite: seam-a | native | format | differential | malformed | e2e
VCD_TESTS_DIR=/path tests/run.sh
```

- The **node suites** (native/format/differential/malformed) are fully headless
  and are the CI core. **Seam A** needs `zig`. **e2e** needs an X display (no
  xvfb bundled — run under a display or `xvfb-run -a node --test
  tests/e2e/app.test.cjs`; `SKIP_E2E=1` opts out; expect WebGPU on a Vulkan
  llvmpipe/SwiftShader fallback in CI).
- **Process isolation is mandatory.** The node suites spawn a worker per fixture
  because the addon `@panic`s/`abort()`s on some inputs (u32 tick overflow; the
  truncated malformed file; `getValueAt` on an event). Isolated, a crash is
  reported for one fixture and the rest continue.

### Asserted vs. tracked

Genuine value/structure errors **fail**. Display-style and known-capability
divergences (style-only, x/z-hex, leading-zero pad, unsupported radix, u32-skip,
real-skip) are **counted and printed**, not failed, so they don't drown the
signal — each suite prints a summary. See `tests/FINDINGS.md` for the
bug-vs-by-design calls left open.

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
pnpm canvas-test          # render the production path, compare to golden, exit 1 on diff
pnpm canvas-test:update   # (re)generate the golden: scripts/canvas-test/golden/scene.{bin,png}
pnpm canvas-test:equiv    # self-contained no-op proof (see below)
```

- `scene.bin` (raw RGBA, the comparison source of truth) and `scene.png` (human
  view) are committed. On a `CHECK FAIL` the actual frame is written to
  `/tmp/canvas-check-actual.png` for eyeballing.
- Determinism holds for before/after runs on the same machine/driver — that is
  what no-op proofs need. Cross-machine pixel identity is not guaranteed (and not
  required); regenerate the golden if you change machines.

### Workflow

1. **Visual change** (intended): make it, run `pnpm canvas-test:update`, commit
   the new golden alongside the code. The PNG diff in review shows the change.
2. **No-op change** (optimization/refactor): make it, run `pnpm canvas-test`. It
   must `CHECK PASS` against the unchanged golden. If it fails, the change wasn't
   a no-op.

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
