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
- [ ] **Timescale precision.** `scene.ts` overlays `{10, ps}`; native emits only
  `{1, ns}`. → when tide-vcd threads precision through.

## Riptide-side

- [ ] **u32 tick ceiling.** GPU/napi path narrows tide's u64 ticks to u32
  (`pack.zig` `t_start`/`t_end` + `assert(ts <= maxInt(u32))`, `main.zig`/`mock_db.zig`
  `end_t`). Checked `@intCast` under ReleaseSafe → **panics** past 2³², not silent
  wrap. → widen the GPU tick path to u64 (or rebase ticks to the view window).
  *(= tests/FINDINGS.md B1; blocks large ps/fs traces.)*
- [ ] **Derived signals.** No expression engine — the VCD precomputes `busy`/`done`
  under a `derived` scope and `scene.ts` tags a cosmetic `derivedExpr`. → when a
  live derivation layer computes them from inputs.
- [ ] **Packaged-build trace path.** Default `app.getAppPath()/native/src/mock.vcd`
  works under `electron .`; a packaged build needs the fixture shipped + path fixed.

## Not shims (don't re-add as work)

- Per-row display config (radix/color/role/…) is **sidecar-owned by design** — UI
  state, never trace data.
- Nav-only chrome signals/scopes are mock-fixture content from `gen_mock_vcd.py`;
  they vanish with a real VCD, no riptide change needed.
