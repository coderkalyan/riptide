# riptide regression/integration tests

Drives the [vcd-tests](../../vcd-tests) oracle corpus against riptide at four
seams (A core, B marshalling, C format/pack, D full app). The oracle
(`oracle/<fixture>.json`, computed by an independent parser) is the answer key;
all times in it are decimal strings (u64-safe).

> Seam A lives in the native build, not here: `native/src/oracle_test.zig`, run
> with `zig build test` (or `tests/run.sh seam-a`). It loads each fixture through
> tide directly — no node, no napi — and asserts `pack.valueAt` decodes to the
> oracle bits. A clean seam A + clean seam-B differential localizes any value bug
> to the napi boundary.

```
tests/
  lib/
    oracle.cjs           corpus locator + addon loader
    decode.cjs           {lsb,msb} -> 4-state bits, path<->handle map
    native-worker.cjs    seam B per-fixture worker (isolated process)
    format-worker.cjs    seam C per-fixture worker (isolated process)
    malformed-worker.cjs  loadVcd outcome probe (isolated process)
    differential-worker.cjs  seam-B differential replay (isolated process)
  native.test.cjs        seam B — getHierarchy + getValueAt vs oracle
  format.test.cjs        seam C — native pill labels (getMockSegments) vs oracle
  differential.test.cjs  seam B — zig-direct (query-fixture exe) vs through-addon, byte-equal
  malformed.test.cjs     malformed-input survival
  e2e/
    seed.cjs             temp .vcd copy + sidecar seeding helper
    app.test.cjs         seam D — Electron app: crash-smoke + value-cell vs oracle
  run.sh                 runner
```

## Running

```
tests/run.sh                       # all suites (e2e only if $DISPLAY set)
tests/run.sh native                # one suite
VCD_TESTS_DIR=/path/to/vcd-tests tests/run.sh
```

The three node suites are **fully headless** (`node --test`, no display, no GPU) —
they load the production N-API addon (`dist/native/riptide.node`) directly under
node. Run `pnpm build` first (or `node scripts/build.mjs --steps=native`). The **e2e** suite drives the real Electron
app and needs an X display (no xvfb in this env; run under a display or
`xvfb-run -a node --test tests/e2e/app.test.cjs`).

## Why each fixture runs in its own process

The addon `@panic`s (calls `abort()`) on some inputs (u32 time overflow, the
truncated malformed file). A single in-process run would die on the first such
fixture and report nothing for the rest. Each worker is spawned per fixture, so a
panic is confined and reported as a *crash* rather than taking down the suite.

## What is asserted vs. tracked

Genuine value/structure errors **fail**. Divergences that are display-style or
known capability gaps are **counted and printed** (see each suite's summary) so
they don't drown the real signal:

- **style** — `0x`-prefixed UPPERCASE hex vs the oracle's bare lowercase (bits
  identical).
- **pad** — leading-zero width padding (native pill pads; JS UI strips).
- **x/z hex** — oracle collapses unknown nibbles (any-x→x, all-z→z); riptide
  renders per-nibble `X`/`Z`.
- **unsupported radix** — oracle `oct` / `dec-signed`: riptide's pack spec has no
  such mode (only bin/hex/dec/enum).
- **u32 time cap / real values** — see below.

## Known-failing (real riptide findings, as of this writing)

These are intentionally left red — they are bugs/gaps in riptide, not the harness:

1. **u32 time cap → crash.** The napi boundary takes ticks as `uint32`
   (`getValueAt`, `getMockSegments`, `endTicks`). Any VCD with timestamps > 2³²
   (`time_long_sparse`, `time_u64_extreme`) `@panic`s at parse — *not* a graceful
   error. This is a harder limit than the f64/53-bit hazard the methodology
   targets.
2. **Hex nibble misgrouping for widths not a multiple of 4.** A 7-bit value
   `1111011` formats as `0xF3` instead of `0x7b` — nibbles are grouped from the
   MSB. Present in both `native/src/label.zig` and `wave/value.ts`
   (`formatSegmentValue`); affects pill labels and the value column. Fails
   `format: hier_balanced_soc` and `e2e values: hier_balanced_soc`.
3. **`getValueAt` on an `event` signal aborts.** `feat_var_types` `types.an_event`
   → SIGABRT ("reached unreachable code") in `pack.valueAt`/`db.query`. In-app a
   cursor over an active event row would crash. Fails `differential: feat_var_types`
   (the exhaustive per-signal sweep caught what oracle sampling missed).
4. **No malformed-input diagnosis.** `malformed_truncated.vcd` `@panic`s
   ("reached unreachable code"); the other three load with no warning. The
   suite asserts only survival (no hang) until a structured warning channel
   exists.

The seam-B differential (`differential.test.cjs`) byte-verified **3.2M** marshalled
samples with **zero** boundary mutations on the loadable fixtures — the napi value
path is faithful within its u32 limits; its 3 reds are the two u32 crashes + the
event abort above.

## Coverage gaps (not bugs, but uncovered)

- **Reals** — `getValueAt` returns bits, not the f64; real signals are skipped.
- **Decimation / draw-budget** (seam C pack invariants) and **perf/jank** are not
  yet asserted — they need the `visible_transitions` / `drawn_primitive_count` /
  frame-telemetry hooks from METHODOLOGY §2.
