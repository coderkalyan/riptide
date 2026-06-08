# riptide — regression-suite findings

State captured by `tests/` (the vcd-tests oracle harness) on 2026-06-04, addon
built from `dist/native/riptide.node`. Bugs are **reported, not fixed**.

Suite tallies (per-fixture, isolated processes):

| Suite | Seam | Result |
|---|---|---|
| `zig build test` | A (tide core, in-process) | **pass** · 6397 samples, 0 failures |
| `native`       | B (marshalling) | 24/26 pass |
| `format`       | C (format+pack) | 23/26 pass |
| `differential` | B (boundary byte-equality) | 24/27 pass · **3.2M** samples byte-verified |
| `malformed`    | — | 4/4 survive |
| `e2e`          | D (full app) | smoke pass · 2/3 value fixtures pass |

Seam A (tide-direct) is **green** and seam-B differential found **zero** boundary
mutations — so every value bug below is either a *crash* (B1/B3) or a *formatter*
bug (B2), never a silent core/marshalling value corruption. That's the strongest
statement the corpus can make about fidelity.

The reds are the bugs below — not harness defects. Style/spec divergences are
classified out so they don't mask real value errors (see §Divergences).

---

## Bugs

### B1 — u32 time cap → hard crash on parse  *(FIXED)*
**Fixed:** the napi/GPU tick path is now u64. `end_t`/`PackOpts.end_t` are u64,
`getMockSegments`/`getValueAt`/`getEdges` read ticks via `napi_get_value_int64`
and return `endTicks`/edge ticks as JS numbers (f64, exact to 2⁵³), and
`pack.packSignal` carries the LOW 32 bits of each timestamp into the GPU segment
buffer (the shader works in deltas relative to start_ticks, also a low-32 word, so
i32 wraparound yields the correct on-screen offset). `time_u64_extreme` now passes
`native`/`format`/`differential` (huge *absolute* time, normal per-segment spans).
`time_long_sparse` passes the *value* suites (`native`/`differential`) but, as of
the v0.1-alpha prep, intentionally **trips a new assert in `format`/pack**: it holds
a value across a span > 2³¹ ticks, which the GPU segment buffer (low-32 tick + i32
shader delta) can't position. `pack.zig` `assertRenderableSpan` now aborts on any
single segment span > 2³¹ ticks instead of rendering it at a garbled / negative x —
so such a trace fails *loudly* rather than silently. Proper fix: widen the GPU tick
pipeline to 64-bit (PERFORMANCE.md).

Original report: the napi boundary took ticks as `uint32` (`getValueAt` tick,
`getMockSegments` `qStart`/`qEnd`, `endTicks`). Any VCD whose timestamps exceeded
2³² panicked **at load** — `mem.zig:3329 "integer does not fit in destination
type"` in `mock_db.load` — and `abort()`d the process rather than erroring.

- Hits `time_long_sparse` (span 1e12) and `time_u64_extreme` (span 2⁶³).
- The Zig core is actually u64-clean (`pack.valueAt(db, id, t: u64)`); the cap is
  purely the napi marshalling + an `@intCast(u32)` in `pack.packSignal`.
- This is **harder** than the f64/53-bit hazard the methodology targets — riptide
  truncates at 32 bits and crashes instead of silently truncating.
- Fixtures: `native` ✖, `format` ✖, `differential` ✖ (all = the same crash).

### B2 — hex nibble misgrouping for widths not a multiple of 4
A 7-bit value `1111011` (= `0x7b`) formats as `0xF3`. Nibbles are grouped from
the **MSB**: the top nibble takes 4 bits, the bottom gets the leftover 3.

- Root cause `src/renderer/wave/value.ts:~80` (`formatSegmentValue`): the hex loop
  is `for (hi = bitWidth-1; hi >= 0; hi -= 4)` — should align nibble boundaries to
  the LSB. Same logic is ported into `native/src/label.zig`, so **both** the value
  column and the GPU pill label are wrong.
- `getValueAt` returns the *bits* correctly — only the formatter is wrong.
- Confirmed end-to-end: `e2e values: hier_balanced_soc` shows `0xD5` vs `6d`,
  identical to the seam-C pill divergence.
- Fixtures: `format: hier_balanced_soc` ✖ (opcode, width 7), `e2e` ✖.

### B3 — `getValueAt` on an `event` signal aborts the process
`feat_var_types` `types.an_event` (VCD `event` type) → SIGABRT, "reached
unreachable code" in `pack.valueAt` / `db.query`. A cursor/hover over an active
event row in-app would crash the renderer.

- Found by the differential's exhaustive per-signal sweep; the oracle-sampled
  `native` test missed it (it didn't query that signal at those ticks).
- Fixtures: `differential: feat_var_types` ✖ (surfaces as a query-fixture crash).

### B4 — malformed input: crash or silent accept, never diagnosed
METHODOLOGY §9 wants survived + diagnosed + partially-correct. riptide has no
warning/error channel, so:

| file | outcome |
|---|---|
| `malformed_truncated.vcd`     | **crash** — `@panic` "reached unreachable code" |
| `malformed_backwards_time.vcd`| loads silently (nodes=2) |
| `malformed_bad_width.vcd`     | loads silently (nodes=2) |
| `malformed_no_enddefs.vcd`    | loads silently (nodes=3) |

All four *survive* (no hang) — the only thing currently assertable.

---

## Spec / style divergences (judgment calls — bug or by-design?)

Bits are correct in every case below; only the displayed string differs from the
oracle's canonical `format_value()`. The harness counts these separately and does
**not** fail on them — decide which side is canonical.

- **Hex prefix + case.** riptide `0x`-prefixed UPPERCASE (`0xF7`); oracle bare
  lowercase (`f7`). 2391 occurrences.
- **Leading-zero padding — and a native↔JS inconsistency.** The native pill
  formatter pads to full width (`0x0B310D14`); the JS value column strips leading
  zeros (`0x5B6E6E3`). CLAUDE.md says the two formatters must stay byte-for-byte in
  sync — they don't.
- **x/z hex.** Oracle spec collapses unknown nibbles (any-x→x, all-z→z); riptide
  renders per-nibble `X`/`Z`, preserving the z-vs-x distinction (`0xZZ` vs `xx`).
  9 occurrences. Arguably more informative, but divergent.
- **Missing radices.** The pack spec (`NativePackSpec.radix`) only has
  bin/hex/dec/enum. The oracle exercises **octal** and **signed-decimal**
  (`dec-signed`) that riptide can't render — 2 fixtures' signals skipped.

---

## Coverage gaps (uncovered, not bugs)

- **Reals.** `getValueAt` returns 4-state bits, not the f64; real signals are
  skipped in value/format checks (46 + 5 samples).
- **Decimation / draw-budget** and **perf/jank** — need the `visible_transitions`,
  `drawn_primitive_count`, and frame-telemetry hooks (METHODOLOGY §2) that the
  viewer doesn't expose yet.
- **Events** are excluded from seam A (would abort, B3) and reals from all value
  checks — both are reported gaps, not silent passes.

---

## Determinism / testability notes

- **The harness is deterministic** — fixed corpus, fixed oracles, no wall-clock,
  no RNG. The `query-fixture` dump strides transitions deterministically.
- **What makes riptide hard to test headlessly:**
  - **B1 removes 2 fixtures from every suite** (they crash before any assertion).
  - **No headless GPU here** — no xvfb installed; the e2e ran on the live
    `DISPLAY=:0`. The node suites (native/format/differential/malformed) need no
    display and are the CI core. For CI, wrap e2e in `xvfb-run` (and expect Vulkan
    llvmpipe / SwiftShader fallback for WebGPU).
  - **Autosave writes the sidecar** — the e2e copies each fixture to a temp dir and
    seeds the sidecar there so autosave can't clobber the shared corpus.
  - **No viewer query hooks** — seam-D value checks read the `.s-row .v` DOM cell,
    which only exists for active rows; the sidecar seeds them. Deeper navigation
    (`find_next_edge`) / decimation asserts need the hooks above.
  - No value-level nondeterminism was observed: the value column is a pure function
    of (handle, cursor tick).
