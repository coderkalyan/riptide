# Sample traces (manual testing)

Tiny hand-written VCDs for exercising edge cases. Open via **File ▸ Open VCD…**
(no sidecar ships alongside them, so they open empty — add signals from the tree
to see the waveform area).

- **`empty.vcd`** — header + a `$dumpvars` block at time 0, no later transitions.
  Native `end_t` clamps to `max(1, last_tick) = 1`, so `TRACE_END == 1`.
- **`single-edge.vcd`** — values at `#0` plus a single edge at `#1`. Also
  `TRACE_END == 1`.
- **`unsupported-types.vcd`** — `clk` (wire) + `data` (reg) carry samples and are
  addable; `analog` (a `real`, whose value changes tide can't represent) and
  `untouched` (a wire that's declared but never assigned) carry **no** samples.
  Both render **dimmed + non-addable** in the signal tree with an "unsupported
  type" tooltip — instead of crashing the pack path (`getMockSegments` would
  `@panic` on a handle tide never ingested). The `Signal.supported` flag (native,
  via db membership) drives this; the tree, `store.addSignal`/`addSignals`, and
  sidecar `resolveView` all skip unsupported signals.

Both load with `endTicks == 1` (`TRACE_END == 1`) — the degenerate
**loaded-but-empty / single-event** case. A fresh trace opens with no active
signals, so the canvas just renders an empty ruler and reads fine; the collapsed
~1 px timeline only shows if you add a signal from the tree. Judged acceptable for
v0.1-alpha (the empty state isn't misleading), so the review item is **closed** —
these files are kept as regression inputs in case degenerate-trace handling is
revisited later.

## `sdi/` — source debug info sample

A complete worked example of the [SDI format](../docs/sdi.md) rather than a trace
edge case. Not loaded by the app (no importer yet); it is the fixture
`tests/sdi.test.cjs`, `tools/sdi-cone.mjs` and `crates/sdi-verilator` run against.

- **`gate.sv`** — 98 lines of SystemVerilog chosen to exercise every axis the
  schema exists for: an enum, a packed struct, three unpacked arrays, a
  parameterized module, a generate loop with two iterations, a black box, control
  dependence, a dynamic index and a read-only assertion. Lints clean under
  `verilator --lint-only --assert`.
- **`crc8.sv`** — the body of `u_crc`, which the SDI deliberately models as a
  black box. Present only so the sample can be simulated.
- **`tb.sv`** — testbench that produced `gate.vcd`.
- **`gate.vcd`** — real Icarus Verilog output (`iverilog -g2012
  -gsupported-assertions`), 39 signals. Shows the two things binding has to cope
  with: vector leaf names carry a space-separated `[msb:lsb]` token, and the three
  unpacked arrays are missing entirely because `$dumpvars` does not dump them.
- **`gate.vcd.sdi.json`** — hand-authored SDI covering `gate.sv` completely: 13
  types, 5 units, 22 declared variables (30 after elaboration), 79 refs, 89 source
  spans. Every span was derived from the file: `decl` spans cover exactly the
  declared identifier, and `files[0].blake3` pins the source. Editing `gate.sv`
  without regenerating the SDI fails the test suite.

```sh
node tools/sdi-cone.mjs samples/sdi/gate.vcd.sdi.json check samples/sdi/gate.vcd
node tools/sdi-cone.mjs samples/sdi/gate.vcd.sdi.json cone dut.sum
```

The same design also drives the producer proof of concept, which regenerates an
equivalent SDI from a real Verilator run rather than by hand:

```sh
verilator --json-only --assert -Wno-DECLFILENAME -Wno-UNUSEDSIGNAL \
  --Mdir /tmp/vj samples/sdi/gate.sv samples/sdi/crc8.sv --top-module gate
cargo run --release -p sdi-verilator -- /tmp/vj/Vgate.tree.json --out /tmp/gen.sdi.json \
  --trace samples/sdi/gate.vcd --root-prefix tb --root-name dut \
  --source-root samples/sdi --unpacked-arrays omit
node tools/sdi-cone.mjs /tmp/gen.sdi.json check samples/sdi/gate.vcd
```

The generated file is not committed — `tests/sdi.test.cjs` produces it into a temp
directory and asserts it validates, resolves every ref, binds every signal, and
yields the same cone as the hand-authored one. The hand-authored file stays the
fixture because it models `u_crc` as a black box, which the Verilator run cannot
(it is given `crc8.sv`).
