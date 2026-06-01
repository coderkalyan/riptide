#!/usr/bin/env python3
"""Generate native/src/mock.vcd — the fixture that drives riptide's mock scene.

This replaces the hand-built tide.Database that used to live in mock_db.zig.
The rendered rows (under top.keysched.waves and the derived scope) reproduce the
EXACT transitions the old V_* arrays produced; everything else is navigation
chrome so the SignalTree looks like a realistic design with extra addable signals.

Run from the repo root (or anywhere):  python3 native/scripts/gen_mock_vcd.py
Output: native/src/mock.vcd  (deterministic; safe to regenerate + commit).

Var references are written FUSED (e.g. `state[1:0]`) as a single token because
tide-vcd's parseVar keeps the reference token and discards a separate bit-range
token — so the fused form is what yields the names riptide's paths expect.
"""

import os

# Tick layout shared with the renderer (MOCK_CLOCK_TICK_NS = 5, end = 90).
T = [0, 5, 15, 25, 35, 45, 55, 65, 75, 85]
END = 90
X = "x"
Z = "z"

# Clock toggles every 5ns across the whole window (matches old insertClk).
CLK = [(i * 5, i % 2) for i in range(END // 5)]


class Sig:
    """A VCD variable: name (fused, incl. any bit-range), width, vcd type, and a
    list of (tick, value) changes. value is an int, or "x"/"z"."""

    def __init__(self, name, width, vtype, changes):
        self.name = name
        self.width = width
        self.vtype = vtype  # "wire" or "reg"
        self.changes = changes
        self.code = None  # assigned at emit time


class Scope:
    def __init__(self, name, sigs=None, scopes=None):
        self.name = name
        self.sigs = sigs or []
        self.scopes = scopes or []


# ---- rendered rows: EXACT reproduction of the old mock_db V_* arrays --------

waves = Scope("waves", sigs=[
    Sig("clk", 1, "wire", CLK),
    Sig("rst", 1, "reg", [(0, 1), (10, 0)]),
    Sig("state[1:0]", 2, "reg", [(0, X), (15, 0), (35, 1), (45, 2), (65, 1), (75, 0)]),
    Sig("cycle_count[7:0]", 8, "reg",
        [(0, X), (15, 0), (25, 1), (35, 2), (45, 3), (55, 4), (65, 5), (75, 6), (85, 7)]),
    Sig("in_valid", 1, "reg", [(0, 0), (25, 1), (45, 0), (55, 1), (75, 0)]),
    Sig("in_data[7:0]", 8, "reg", [(0, X), (25, 0xA3), (45, X), (55, 0xB7), (75, X)]),
    Sig("in_addr[15:0]", 16, "reg",
        [(0, X), (25, 0x1000), (35, 0x1004), (45, X), (55, 0x1008), (65, 0x100C), (75, X)]),
    Sig("out_valid", 1, "reg", [(0, 0), (45, 1), (85, 0)]),
    Sig("out_data[31:0]", 32, "reg",
        [(0, X), (45, 0xDEADBEEF), (65, 0xCAFEB0BA), (85, X)]),
    Sig("fifo_level[3:0]", 4, "reg", [(0, X), (15, 0), (25, 1), (35, 2), (65, 1), (75, 0)]),
    Sig("fifo_empty", 1, "wire", [(0, X), (15, 1), (25, 0), (75, 1)]),
    Sig("dbus[7:0]", 8, "wire", [(0, X), (15, Z), (25, 0x55), (45, Z), (55, 0xF0), (75, Z)]),
])

# Derived signals: stored as ordinary precomputed waveforms (busy = in_valid |
# out_valid, done = state == DONE). tide has no derived/expression support.
derived = Scope("derived", sigs=[
    Sig("busy", 1, "wire", [(0, 0), (25, 1), (85, 0)]),
    Sig("done", 1, "wire", [(0, 0), (75, 1), (85, 0)]),
])

# ---- navigation chrome: realistic extra signals the user can drag in --------

keysched = Scope("keysched", sigs=[
    Sig("clk", 1, "wire", CLK),
    Sig("rst_n", 1, "wire", [(0, 0), (10, 1)]),
    Sig("c[10:0]", 11, "wire", [(0, X), (10, 0), (30, 1), (50, 2), (70, 3)]),
    Sig("load1[0:8]", 9, "wire", [(0, X), (20, 0x0A1)]),
    Sig("load2[0:8]", 9, "wire", [(0, X), (20, 0x0B2)]),
    Sig("load3[0:8]", 9, "wire", [(0, X), (20, 0x0C3)]),
    Sig("data[31:0]", 32, "wire", [(0, X), (30, 0xCAFEF00D)]),
    Sig("state[1:0]", 2, "wire", [(0, X), (20, 1), (60, 2)]),
], scopes=[
    Scope("fsm", sigs=[
        Sig("cur[2:0]", 3, "wire", [(0, 0), (25, 1), (45, 2), (75, 4)]),
        Sig("nxt[2:0]", 3, "wire", [(0, 1), (25, 2), (45, 4), (75, 0)]),
    ]),
    Scope("xbar", sigs=[
        Sig("req[3:0]", 4, "wire", [(0, 0), (25, 0x5), (55, 0xA)]),
        Sig("gnt[3:0]", 4, "wire", [(0, 0), (35, 0x4), (65, 0x8)]),
    ]),
    waves,
])

top = Scope("top", scopes=[
    Scope("des"),
    keysched,
    Scope("mem_ctrl", sigs=[
        Sig("addr[7:0]", 8, "wire", [(0, X), (20, 0x40), (60, 0x44)]),
        Sig("wen", 1, "wire", [(0, 0), (20, 1), (30, 0)]),
        Sig("rdata[7:0]", 8, "wire", [(0, X), (40, 0x99)]),
    ]),
    Scope("dma", sigs=[
        Sig("src[15:0]", 16, "wire", [(0, X), (15, 0x2000)]),
        Sig("dst[15:0]", 16, "wire", [(0, X), (15, 0x3000)]),
        Sig("active", 1, "wire", [(0, 0), (15, 1), (75, 0)]),
    ]),
    Scope("uart", sigs=[
        Sig("tx", 1, "wire", [(0, 1), (35, 0), (45, 1)]),
        Sig("rx", 1, "wire", [(0, 1)]),
        Sig("baud[15:0]", 16, "wire", [(0, 0x1B2)]),
    ]),
])

ROOTS = [top, derived]


# ---- emit -------------------------------------------------------------------

def assign_codes(scope, state):
    for s in scope.sigs:
        s.code = chr(33 + state[0])  # '!' onward; well under the 94 printable codes
        state[0] += 1
    for sub in scope.scopes:
        assign_codes(sub, state)


def collect(scope, out):
    out.extend(scope.sigs)
    for sub in scope.scopes:
        collect(sub, out)


def fmt_value(sig, val):
    if sig.width == 1:
        v = val if isinstance(val, str) else str(val)
        return f"{v}{sig.code}"          # scalar: no space
    if isinstance(val, str):
        return f"b{val} {sig.code}"      # bx / bz (extends to width)
    return f"b{format(val, 'b')} {sig.code}"  # minimal binary, MSB-first


def emit_scope(scope, lines, indent):
    pad = "  " * indent
    lines.append(f"{pad}$scope module {scope.name} $end")
    for s in scope.sigs:
        lines.append(f"{pad}  $var {s.vtype} {s.width} {s.code} {s.name} $end")
    for sub in scope.scopes:
        emit_scope(sub, lines, indent + 1)
    lines.append(f"{pad}$upscope $end")


def main():
    state = [0]
    for r in ROOTS:
        assign_codes(r, state)
    sigs = []
    for r in ROOTS:
        collect(r, sigs)

    # $version is required by tide-vcd's header parser ($date is optional, but
    # we include it for realism).
    lines = [
        "$date Mon Jun 01 00:00:00 2026 $end",
        "$version riptide-mock $end",
        "$timescale 1ns $end",
    ]
    for r in ROOTS:
        emit_scope(r, lines, 0)
    lines.append("$enddefinitions $end")

    # Initial values (every signal has a tick-0 change) inside $dumpvars.
    lines.append("#0")
    lines.append("$dumpvars")
    for s in sigs:
        v0 = next(v for (t, v) in s.changes if t == 0)
        lines.append(fmt_value(s, v0))
    lines.append("$end")

    # Group remaining changes by tick, ascending.
    by_tick = {}
    for s in sigs:
        for (t, v) in s.changes:
            if t == 0:
                continue
            by_tick.setdefault(t, []).append((s, v))
    for t in sorted(by_tick):
        lines.append(f"#{t}")
        for (s, v) in by_tick[t]:
            lines.append(fmt_value(s, v))

    # Trailing time marker so the trace end (and thus each last segment's right
    # boundary) is END, not the final change tick.
    lines.append(f"#{END}")

    out_path = os.path.join(os.path.dirname(__file__), "..", "src", "mock.vcd")
    out_path = os.path.normpath(out_path)
    with open(out_path, "w") as f:
        f.write("\n".join(lines) + "\n")
    print(f"wrote {out_path}: {len(sigs)} signals, {len(lines)} lines")


if __name__ == "__main__":
    main()
