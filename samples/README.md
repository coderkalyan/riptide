# Sample traces (manual testing)

Tiny hand-written VCDs for exercising degenerate-trace handling. Open via
**File ▸ Open VCD…** (no sidecar ships alongside them, so they open empty — add
signals from the tree to see the waveform area).

- **`empty.vcd`** — header + a `$dumpvars` block at time 0, no later transitions.
  Native `end_t` clamps to `max(1, last_tick) = 1`, so `TRACE_END == 1`.
- **`single-edge.vcd`** — values at `#0` plus a single edge at `#1`. Also
  `TRACE_END == 1`.

Both reproduce the **loaded-but-empty / single-event** case (release review item
#20, *unresolved*): with `TRACE_END <= 1` the whole timeline fits in ~1 px, so the
ruler shows a single "0 ns / 1 ns", waveforms collapse to a sliver, and fit/zoom
can't open it up. The fix (detect `TRACE_END <= 1` → render a real "empty / no
data" state with a sane default window) is **not** implemented yet — these files
exist to test it against.
