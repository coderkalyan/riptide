# Riptide sidecar format

A **sidecar** is a small JSON file that holds *viewer state* for a trace: which
signals are shown, in what order, how they're styled, where the cursor and
markers sit, the visible time window, and trivial UI chrome (panel widths, tree
expansion, toggles). It is **not** the waveform data — the trace (VCD/FST/tide)
still owns the hierarchy and samples.

Riptide loads the sidecar on start and rewrites it whenever viewer state
changes. There is no "open project" / "save project" step.

- **Default path:** `riptide.sidecar.json` in the working directory.
- **Override:** set `RIPTIDE_SIDECAR=/path/to/file.json` (the CI hook).
- **Delete it** and Riptide opens the trace fresh (every signal, plain styling,
  no markers, fit zoom).

The schema lives in [`docs/sidecar.schema.json`](./sidecar.schema.json)
(JSON Schema 2020-12). Validate generated sidecars in CI before shipping them.

## Why scripts care about this

Drop a VCD from a failing CI run alongside a sidecar that opens the viewer
zoomed to the failure window with exactly the relevant signals on screen. The
reviewer double-clicks and lands on the bug — no manual signal hunting.

A script only needs the `view` section. Omit `ui` entirely; Riptide fills in
defaults.

## Two sections

```jsonc
{
  "version": 1,
  "trace": { "id": "keysched", "format": "fst", "timescale": { /* advisory */ } },

  "view": {                 // REQUIRED — waveform / canvas / time. Scriptable.
    "time":    { "start": 0, "end": 90, "cursor": 32.4 },
    "signals": [ /* render order; array index == row */ ],
    "markers": [ /* named time markers */ ]
  },

  "ui": {                   // OPTIONAL — chrome. Scripts normally omit this.
    "panels":  { "treeWidth": 236, "activeWidth": 296, "treeCollapsed": false,
                 "activeCollapsed": false, "activeCompactWidth": null },
    "tree":    { "expanded": ["top", "top.keysched"] },
    "toggles": { "snapCursor": false, "clockAnchor": true },
    "tabs":    { "open": ["keysched.vcd"], "active": 0 }
  }
}
```

- `trace` is advisory metadata only; it never gates loading.
- `view.time.start/end` define the visible window in ticks. Zoom is derived from
  the window width against the canvas — there is no separate zoom field.
- `view.signals` order **is** the row order. Row indices are never stored;
  reordering the array reorders the rows.

## Signals are keyed by path

Each signal is referenced by its **hierarchical path**, e.g.
`top.keysched.waves.in_data[7:0]`. This is the run-portable key: handles and
internal ids change between runs and tools, but the design hierarchy does not.
A sidecar from one simulation run therefore opens a **different run of the same
design** out of the box.

```jsonc
{ "path": "top.keysched.waves.in_data[7:0]", "radix": "hex", "color": "#F4A698" }
```

Per-signal fields:

| Field      | Required | Notes                                                       |
|------------|----------|-------------------------------------------------------------|
| `path`     | yes      | Dotted path. Derived signals use `derived.<name>`.          |
| `radix`    | yes      | `bin` \| `hex` \| `dec` (unsigned) \| `sdec` (signed) \| `enum`. |
| `color`    | yes      | CSS hex, `#RRGGBB`.                                          |
| `hidden`   | no       | Eye toggled off (dimmed).                                   |
| `selected` | no       | Highlighted/active row.                                     |
| `pinned`   | no       | Sticky header row.                                          |
| `role`     | no       | `clock` \| `reset` \| `valid` — styling / ruler behavior.   |
| `derived`  | no       | `{ "expr": "..." }` — marks a user-derived signal.          |

**Tolerance.** When a sidecar is loaded against a trace, each `path` is resolved
against the live hierarchy. Paths that resolve are shown; paths that don't are
**skipped with a console warning** (the rest of the view still loads). Note the
bit-range suffix (`[7:0]`) is part of the name, so a width change reads as a
"signal not found". A merge/port tool to remap stale paths is future work.

`enumType` and `gate` are reserved in the schema for forward-compatibility but
are currently trace-side and not emitted.

## Markers

```jsonc
{ "name": "M1", "tick": 19.6, "color": "#4fd2bd", "selected": true }
```

Marker ids are assigned at runtime (not stored), so deleting a marker never
reuses a name.

## Writing one from Python (CI)

```python
#!/usr/bin/env python3
"""Emit a riptide sidecar focused on a failure window + relevant signals."""
import json, sys

WAVES = "top.keysched.waves"

def sig(path, radix="hex", color="#9aa0a6", **extra):
    return {"path": f"{WAVES}.{path}", "radix": radix, "color": color, **extra}

sidecar = {
    "version": 1,
    "trace": {"id": "keysched"},
    "view": {
        "time": {"start": 40, "end": 70, "cursor": 55},   # zoom to the bug
        "signals": [
            sig("clk", "bin", "#72F5DF", role="clock", pinned=True),
            sig("state[1:0]", "dec", "#B48CFF", selected=True),
            sig("in_data[7:0]", "hex", "#F4A698"),
            sig("out_data[31:0]", "hex", "#57C88A"),
        ],
        "markers": [
            {"name": "fail", "tick": 55, "color": "#f06b5b", "selected": True},
        ],
    },
    # `ui` omitted — Riptide uses defaults.
}

with open(sys.argv[1] if len(sys.argv) > 1 else "riptide.sidecar.json", "w") as f:
    json.dump(sidecar, f, indent=2)
```

Run Riptide against it with:

```sh
RIPTIDE_SIDECAR=/path/to/failure.sidecar.json riptide   # opens zoomed to the bug
```

## Validate in CI

```sh
npx ajv-cli validate -s docs/sidecar.schema.json -d riptide.sidecar.json
```
