# Tide → Riptide integration — remaining shims

Riptide reads a real VCD via tide-vcd → `tide.Database`. The items below are the
**temporary mocks/overlays still in place** — delete each as the stack grows the
capability. Everything else (pool/pack pipeline, windowed packing,
open-file/sidecar flow) is done; see the code. Todo-only: once an item is real,
remove it from this file rather than recording it as resolved.

Siblings: `tide` at `../tide`, `tide-vcd` at `../tide-vcd` (`native/build.zig.zon`
→ `../../tide`, `../../tide-vcd`).

Each item is binned by *why* it's still mocked:

- **Not in the VCD** — the format carries no such data; closing the gap needs a
  new source (a VCD convention, the sidecar, or an upstream tool), not parsing.
- **In the VCD, not surfaced** — the data is in the trace but riptide drops it,
  tide can't represent it, or tide-vcd doesn't parse it correctly. The fix lives
  in our stack, not the format.
- **Riptide-internal** — engineering shims independent of what the VCD carries.

## Not in the VCD (no source to read)

- [ ] **Enum int→label table.** Mocked in `scene.ts` `ENUM_TYPES` + an `enumTypeId`
  overlay on the signal node; `native.ts` ships `enumTypes` empty. Standard VCD
  carries no enum members. → when a VCD convention (`$comment`/translate) or tide's
  hierarchy starts carrying them.
- [ ] **Signal direction.** VCD `$var` lines carry no port direction, so `walkInto`
  never sets one and `hier.zig` defaults every signal to `.implicit` — the
  renderer's `Direction` enum never sees its other cases. Not surfaced in the UI
  yet, so it's a latent stub. → when tide-vcd (or a VCD convention) supplies port
  direction.
- [ ] **`package` scope kind.** VCD scope types are module/task/function/begin/fork
  only; the fixture declares the package as a plain `module`, and `scene.ts`
  overlays the `package` kind onto the `derived` root. → when the source format
  distinguishes it *and* tide-vcd grows the scope kind.
- [ ] **Timescale precision.** Value+unit are real (`mock_db.zig` maps
  `p.header.timescale` → `Loaded.timescale`, shipped by `main.zig` `getHierarchy`),
  but VCD `$timescale` carries no precision magnitude (that's a Verilog source
  concept), so `scene.ts` still overlays a `{10, ps}` precision. → only if a real
  precision source appears (a sidecar field or a `$comment` convention).

## In the VCD but not surfaced (dropped by riptide / unrepresentable in tide / mis-parsed by tide-vcd)

- [ ] **real / string + weak-pull values.** Present in the event stream, but tide's
  data model is quaternary-only: `mock_db.zig` skips real/string changes and
  collapses weak/pull scalars (`h l u w -`) to `x`. *Cause: tide can't represent
  them.* → when tide gains real/string + weak/pull state. *(reals also surface in
  tests/FINDINGS.md.)*
- [ ] **Fine var-type.** tide-vcd parses the full `$var` type set
  (wire/reg/integer/time/…), but `mock_db.zig` `mapVarType` collapses every one to
  `vcd_wire`/`vcd_reg`, so the renderer's richer `VarType` enum + `scene.ts`
  `vcdTypeOf` switch can never see the other cases. *Cause: riptide throws it
  away.* → widen `mapVarType` to thread the full type through.
## Riptide-internal (independent of the VCD)

- [ ] **Derived signals.** No expression engine — the VCD precomputes `busy`/`done`
  under a `derived` scope and `scene.ts` tags a cosmetic `derivedExpr`. → when a
  live derivation layer computes them from inputs.
- [ ] **Row gating is a hardcoded fixture map.** `GATE_BY_PATH` (`scene.ts`, built
  from `ROWS[].gatePath`) mutes a row while its gate signal isn't logic-1, but the
  signal→gate mapping is hardcoded to the mock's paths (`in_data`/`in_addr`←`in_valid`,
  `out_data`←`out_valid`) and deliberately kept out of the sidecar. → make the gate
  a user-selectable, sidecar-persisted per-row field.
- [ ] **Packaged-build trace path.** Default `app.getAppPath()/native/src/mock.vcd`
  works under `electron .`; a packaged build needs the fixture shipped + path fixed.
