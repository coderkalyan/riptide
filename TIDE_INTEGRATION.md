# Tide → Riptide integration — remaining shims

Riptide reads a real VCD via tide-vcd → `tide.Database`. The items below are the
**temporary mocks/overlays still in place** — delete each as the stack grows the
capability. Everything else (pool/pack pipeline, windowed packing,
open-file/sidecar flow) is wired up; see the code. Todo-only: once an item is
real, remove it from this file rather than recording it as resolved.

Siblings: `tide` at `../tide`, `tide-vcd` at `../tide-vcd` (`native/build.zig.zon`
→ `../../tide`, `../../tide-vcd`).

Each item is binned by *why* it's still mocked:

- **Not in the VCD** — the format carries no such data; closing the gap needs a
  new source (a VCD convention, the sidecar, or an upstream tool), not parsing.
- **In the VCD, not surfaced** — the data is in the trace but riptide drops it,
  tide can't represent it, or tide-vcd doesn't parse it correctly. The fix lives
  in our stack, not the format.
- **Riptide-internal** — engineering shims independent of what the VCD carries.

## ⚠ Crash / leak consequences of these shims (fix before release)

The shims below mostly *degrade* gracefully, but these specific consequences
currently **break** the app on a real (non-mock) trace — promoted here so they
aren't buried:

- [ ] **`event` signals still crash if added.** real / string / never-assigned
  signals are dropped at load (see "real/string" + "Fine var-type" below); the
  renderer now marks them `supported: false` (native db-membership, in
  `getHierarchy`) so the tree disables them and `store.addSignal`/`addSignals` +
  sidecar `resolveView` skip them — closing the common real/string one-click crash.
  **Not** covered: `event` vars, which tide *does* ingest (so they read
  `supported: true`) but `getValueAt`/`pack.valueAt` aborts on (tests/FINDINGS.md
  B3); and the raw backstop `getMockSegments` `db.query(...) orelse
  @panic("missing signal")` (`native/src/main.zig:353`) is still a hard panic.
  Durable fix: turn that `@panic` into a skip (emit an empty packed signal) and
  skip/handle event-type queries.

  *(Resolved: the hardcoded `trace.id: "keysched"` + `"keysched.vcd"` tab-label
  leaks into foreign sidecars — both removed.)*

## Not in the VCD (no source to read)

- [ ] **Enum int→label table.** Mocked in `scene.ts` `ENUM_TYPES` + an `enumTypeId`
  overlay on the signal node; `native.ts` ships `enumTypes` empty. Standard VCD
  carries no enum members. The overlay is path-scoped (try/catch), so it correctly
  no-ops on a non-matching trace. → when a VCD convention (`$comment`/translate) or
  tide's hierarchy starts carrying them.
- [ ] **Signal direction.** VCD `$var` lines carry no port direction, so `walkInto`
  never sets one and `hier.zig` defaults every signal to `.implicit` — the
  renderer's `Direction` enum never sees its other cases. Not surfaced in the UI
  yet, so it's a latent stub. → when tide-vcd (or a VCD convention) supplies port
  direction.
- [ ] **`package` scope kind.** VCD scope types are module/task/function/begin/fork
  only; the fixture declares the package as a plain `module`, and `scene.ts`
  overlays the `package` kind onto the `derived` root. Foot-gun: `scene.ts:292`
  restyles *any* root scope literally named `derived`, so a foreign design with a
  top-level module of that name is mislabeled. → when the source format
  distinguishes it *and* tide-vcd grows the scope kind.
- [ ] **Timescale precision — applied unconditionally to every trace.** Value+unit
  are real (`mock_db.zig` maps `p.header.timescale` → `Loaded.timescale`), but VCD
  `$timescale` carries no precision magnitude, and `scene.ts:281` overlays a
  fabricated `{10, ps}` precision onto **every** loaded trace (not just the mock) —
  so all real traces mis-report precision. Fix: leave precision `undefined` unless
  a real source (a sidecar field or a `$comment` convention) supplies it.

## In the VCD but not surfaced (dropped by riptide / unrepresentable in tide / mis-parsed by tide-vcd)

- [ ] **real / string + weak-pull values.** Present in the event stream, but tide's
  data model is quaternary-only: `mock_db.zig:227` skips real/string changes and
  collapses weak/pull scalars (`h l u w -`) to `x`. *Cause: tide can't represent
  them.* Until then these signals carry zero samples and **must not be added to a
  row** (see the crash hazard above). → when tide gains real/string + weak/pull
  state. *(reals also surface in tests/FINDINGS.md.)*
- [ ] **Fine var-type.** tide-vcd parses the full `$var` type set
  (wire/reg/integer/time/…), but `mock_db.zig` `mapVarType` collapses every one to
  `vcd_wire`/`vcd_reg`, so the renderer's richer `VarType` enum + `scene.ts`
  `vcdTypeOf` switch can never see the other cases. *Cause: riptide throws it
  away.* → widen `mapVarType` to thread the full type through.

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
