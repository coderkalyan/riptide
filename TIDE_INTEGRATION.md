# Tide → Riptide integration — remaining shims

Riptide reads a real VCD via tide-vcd → `tide_core::Trace`. The items below are the
**temporary mocks/overlays still in place** — delete each as the stack grows the
capability. Everything else (pool/pack pipeline, windowed packing,
open-file/sidecar flow) is wired up; see the code. Todo-only: once an item is
real, remove it from this file rather than recording it as resolved.

Submodule: the `tide` Rust workspace at `./tide` (`native/Cargo.toml` →
`../tide/crates/tide-core`, `../tide/crates/tide-vcd`).

Each item is binned by *why* it's still mocked:

- **Not in the VCD** — the format carries no such data; closing the gap needs a
  new source (a VCD convention, the sidecar, or an upstream tool), not parsing.
- **In the VCD, not surfaced** — the data is in the trace but riptide drops it,
  tide can't represent it, or tide-vcd doesn't parse it correctly. The fix lives
  in our stack, not the format.
- **Riptide-internal** — engineering shims independent of what the VCD carries.

## ⚠ Crash / leak consequences of these shims (fix before release)

*(Resolved with the Rust addon. `getMockSegments` no longer aborts on a signal
the database never stored: an unknown or unsupported handle packs to an empty
row, and a bad `loadVcd` throws a JS error instead of calling `abort`. The
renderer still marks real / never-assigned signals `supported: false` from
native db membership, so the tree disables them, but that is now a nicety rather
than the only thing between a click and a dead process.)*

## Not in the VCD (no source to read)

- [ ] **Timescale precision — applied unconditionally to every trace.** Value+unit
  are real (`trace.rs` reads them off `LoadReport::timescale`), but VCD
  `$timescale` carries no precision magnitude, and `scene.ts:281` overlays a
  fabricated `{10, ps}` precision onto **every** loaded trace (not just the mock) —
  so all real traces mis-report precision. Fix: leave precision `undefined` unless
  a real source (a sidecar field or a `$comment` convention) supplies it.

## In the VCD but not surfaced (dropped by riptide / unrepresentable in tide / mis-parsed by tide-vcd)

- [ ] **real / string + weak-pull values.** Present in the event stream, but the
  database stores four-state logic only (bounds plus a high impedance mask):
  `tide_vcd::load` counts real and string records as skipped, and the codec
  collapses weak/pull scalars (`h l u w -`) to `x`. *Cause: tide can't represent them.* A real variable is at least listed and
  typed now, with `supported: false` and no samples behind it. → when tide gains
  real/string + weak/pull state.
- [ ] **Event variables vanish entirely.** An event is an occurrence rather than a
  value — a point, not the step function every other variable describes — so
  `tide_vcd::load` leaves it out of the hierarchy (`skipped_vars`) and the signal
  tree never shows it. It used to appear, disabled. → when tide grows a
  step/point axis.
- [ ] **Derived signals.** No expression engine — the VCD precomputes `busy`/`done`
  under a `derived` scope and `scene.ts` tags a cosmetic `derivedExpr`. → when a
  live derivation layer computes them from inputs.
- [ ] **No sidecar schema validation / migration.** `sidecar.ts` accepts any v1
  file past a version-equality + `view.signals`-present check; bad field types
  (e.g. unknown `radix`) flow into the formatter (mis-format, no crash), and there
  is no migration path for a future v2. A read-only trace directory makes the
  autosave write fail **silently** (console.warn only — view edits are lost with no
  user-facing signal). Fine for alpha; note for v0.2.
