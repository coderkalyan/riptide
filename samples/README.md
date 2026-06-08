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
