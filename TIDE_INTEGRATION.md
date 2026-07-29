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

- [ ] **Enum int→label table.** Mocked in `scene.ts` `ENUM_TYPES` + an `enumTypeId`
  overlay on the signal node; `native.ts` ships `enumTypes` empty. Standard VCD
  carries no enum members. The overlay is path-scoped (try/catch), so it correctly
  no-ops on a non-matching trace. → when a VCD convention (`$comment`/translate) or
  tide's hierarchy starts carrying them.
- [ ] **Signal direction.** VCD `$var` lines carry no port direction, so tide's
  hierarchy models none and `lib.rs` emits the literal `"implicit"` for every
  signal — the renderer's `Direction` enum never sees its other cases. Not
  surfaced in the UI yet, so it's a latent stub. → when tide-vcd (or a VCD
  convention) supplies port direction.
- [ ] **Scope kind fidelity.** tide's `ScopeKind` is format-agnostic
  (`Instance`/`Block`/`Procedure`/`Container`/`Other`), so `hierarchy.rs` reports
  a VCD `function` as `"task"` and a `fork` as `"begin"` — the pairs collapse. No
  VCD scope maps to `package` at all; the fixture declares its package as a plain
  `module` and `scene.ts` overlays the kind onto the `derived` root. Foot-gun:
  `scene.ts:292` restyles *any* root scope literally named `derived`, so a
  foreign design with a top-level module of that name is mislabeled. → when tide
  carries the source spelling alongside its own axis.
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
- [ ] **Fine var-type.** tide-vcd parses the full `$var` type set
  (wire/reg/integer/time/…), but tide's hierarchy keeps only the container axis
  (`Net`/`Variable`/`Parameter`), which `hierarchy.rs` maps to `vcd_wire`/
  `vcd_reg`, so the renderer's richer `VarType` enum + `scene.ts` `vcdTypeOf`
  switch can never see the other cases. → when tide carries the declared type.

## Riptide-internal (independent of the VCD)

- [ ] **Derived signals.** No expression engine — the VCD precomputes `busy`/`done`
  under a `derived` scope and `scene.ts` tags a cosmetic `derivedExpr`. → when a
  live derivation layer computes them from inputs.
- [ ] **`ROWS` is dead-but-present.** `scene.ts:89-104` reads like the live default
  view but only `path` + `enumTypeId` are consumed (`scene.ts:283-288`); the
  curated mock view actually comes from the bundled
  `native/src/mock.vcd.sidecar.json`, so `row/radix/color/role/pinned/derivedExpr/
  vcdType` are never read. Don't "fix" the view by editing `ROWS` — shrink it to a
  `path → enumTypeId` map (or fold into `ENUM_TYPES`).
- [ ] **No sidecar schema validation / migration.** `sidecar.ts` accepts any v1
  file past a version-equality + `view.signals`-present check; bad field types
  (e.g. unknown `radix`) flow into the formatter (mis-format, no crash), and there
  is no migration path for a future v2. A read-only trace directory makes the
  autosave write fail **silently** (console.warn only — view edits are lost with no
  user-facing signal). Fine for alpha; note for v0.2.
