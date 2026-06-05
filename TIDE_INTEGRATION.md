# Tide → Riptide integration — remaining shims

Riptide reads a real VCD via tide-vcd → `tide.Database`. The items below are the
**temporary mocks/overlays still in place** because tide / tide-vcd / VCD don't
carry that info yet — delete each as the stack grows the capability. Everything
else (pool/pack pipeline, windowed packing, open-file/sidecar flow) is done; see
the code.

Siblings: `tide` at `../tide`, `tide-vcd` at `../tide-vcd` (`native/build.zig.zon`
→ `../../tide`, `../../tide-vcd`).

## Trace-data gaps (tide/tide-vcd can't supply)

- [ ] **Enum int→label table.** Mocked in `scene.ts` `ENUM_TYPES` + an `enumTypeId`
  overlay on the signal node; `native.ts` ships `enumTypes` empty. → when a VCD
  (`$comment`/translate) or tide's hierarchy carries enum members.
- [ ] **real / string values.** `mock_db.zig` skips real/string changes; weak/pull
  scalars (`h l u w -`) collapse to `x` (tide is quaternary-only). → when tide
  gains real/string + weak/pull state. *(reals also surface in tests/FINDINGS.md.)*
- [ ] **`package` scope kind.** `scene.ts` overlays it onto the `derived` root
  (declared as a `module` in the VCD). → when tide-vcd grows scope kinds.
- [ ] **Timescale (whole thing).** `main.zig` `getHierarchy` hardcodes
  `{value:1, unit:"ns"}` — it never reads tide-vcd's parsed `$timescale`, so a
  `10 ps` (etc.) trace still reports `1 ns`. `scene.ts` then overlays a `{10, ps}`
  precision on top. → read the real value+unit from tide-vcd and thread precision
  through (not just precision — the unit is faked too).
- [ ] **Signal direction + fine var-type.** `mock_db.zig` `mapVarType` collapses
  every tide-vcd var type to `vcd_wire`/`vcd_reg`, and `walkInto` never sets a
  direction, so `hier.zig` defaults it to `.implicit` for every signal — the
  renderer's richer `Direction`/`VarType` enums (+ `scene.ts` `vcdTypeOf` switch)
  can never see their other cases. Direction isn't surfaced in the UI yet, so it's
  a latent stub. → when tide-vcd carries port direction + the full var-type set.

## Riptide-side

- [ ] **u32 tick ceiling.** GPU/napi path narrows tide's u64 ticks to u32
  (`pack.zig` `t_start`/`t_end` + `assert(ts <= maxInt(u32))`, `main.zig`/`mock_db.zig`
  `end_t`). Checked `@intCast` under ReleaseSafe → **panics** past 2³², not silent
  wrap. → widen the GPU tick path to u64 (or rebase ticks to the view window).
  *(= tests/FINDINGS.md B1; blocks large ps/fs traces.)*
- [ ] **Derived signals.** No expression engine — the VCD precomputes `busy`/`done`
  under a `derived` scope and `scene.ts` tags a cosmetic `derivedExpr`. → when a
  live derivation layer computes them from inputs.
- [ ] **Clock period/phase hardcoded.** `MOCK_CLOCK_TICK_NS = 5` (`gpu/data.ts`)
  fixes a 5 ns half-period clock with its first rising edge at tick 5. The
  clock-anchored ruler (`#cycle`), the cursor↔marker "N clks" span, snap-to-edge
  (all `wave/format.ts`), and the dashed background grid (`WaveCanvas.tsx` ~397)
  all derive from it — silently wrong for any trace whose clock differs. → measure
  period/phase from the actual clock signal's transitions (the `role:"clock"` row).
- [ ] **Reset-held window hardcoded.** `RESET_HELD_TICKS = {0, 10}` (`scene.ts`)
  drives the crosshatch "RESET" overlay band (`WaveCanvas.tsx` ~366), pinned to the
  mock's reset deassert at tick 10. → derive the held interval from the actual
  reset signal (the `role:"reset"` row).
- [ ] **Row gating is a hardcoded fixture map.** `GATE_BY_PATH` (`scene.ts`, built
  from `ROWS[].gatePath`) mutes a row while its gate signal isn't logic-1, but the
  signal→gate mapping is hardcoded to the mock's paths (`in_data`/`in_addr`←`in_valid`,
  `out_data`←`out_valid`) and deliberately kept out of the sidecar. → make the gate
  a user-selectable, sidecar-persisted per-row field (then it leaves this list and
  joins the sidecar-owned set below).
- [ ] **Dead `MOCK_END_TICKS`.** `gpu/data.ts` still exports `MOCK_END_TICKS = 90`;
  `TRACE_END` / native `endTicks` replaced it and nothing reads it. → delete.
- [ ] **Packaged-build trace path.** Default `app.getAppPath()/native/src/mock.vcd`
  works under `electron .`; a packaged build needs the fixture shipped + path fixed.

## Not shims (don't re-add as work)

- Per-row display config (radix/color/role/…) is **sidecar-owned by design** — UI
  state, never trace data.
- Nav-only chrome signals/scopes are mock-fixture content from `gen_mock_vcd.py`;
  they vanish with a real VCD, no riptide change needed.
