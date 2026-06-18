---
name: bug-sidecar-row-overflow
description: Sidecar load path (resolveView) does NOT cap active row count at MAX_ROWS=64, unlike addSignal/addSignals. A sidecar with >64 resolvable signals native-panics on open (ReleaseSafe assert).
metadata:
  type: project
---

**OPEN BLOCKER as of 2026-06 review.** Two row-cap enforcement points disagree:
- `store.ts` `addSignal` / `addSignals` (runtime add-from-tree) DO cap at `MAX_ROWS` (=64, from gpu/colors.ts).
- `sidecar.ts` `resolveView` (loads activeSignals from `<trace>.sidecar.json` on open/swap) does NOT — `row = row++` unbounded over `view.signals`.

A sidecar listing >64 resolvable signal paths → activeSignals with row ≥ 64 → `getMockSegments` → `Scene.pushPackedSignal` → `std.debug.assert(row < MAX_ROWS)`. Native build is **ReleaseSafe** (package.json build:native), so the assert is LIVE → native panic → renderer crash on open. Also `writeRowColors` (colors.ts) `throw`s for row≥64 from inside a Solid subscriber (uncaught).

**Why it matters for release:** hand-edited / stale / cross-design sidecars are user-facing files. Opening one shouldn't crash the app.

**Fix options:** clamp/slice in `resolveView` to MAX_ROWS (drop extras + warn), OR raise MAX_ROWS and bound-check natively returning an error instead of asserting. MAX_ROWS lives in gpu/colors.ts (renderer) + segments.zig (native) — keep in sync if raised.
