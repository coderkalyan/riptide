"use strict";
// Loads one (possibly malformed) VCD through the addon and reports the outcome
// mode. Runs isolated so a Zig @panic only kills this worker.
//
// argv[2] = absolute path to the .vcd
// Prints RESULT:<json> with mode ∈ { loaded, threw } and, when loaded, the node
// count + endTicks so the parent can sanity-check partial parse. A panic/abort
// produces no RESULT line and a nonzero exit -> parent records mode "crashed".

const { loadAddon } = require("./oracle.cjs");

const vcd = process.argv[2];
const native = loadAddon();

let out;
try {
  native.loadVcd(vcd); // throws (JS) on a clean rejection; panics (abort) otherwise
  const h = native.getHierarchy();
  out = { mode: "loaded", nodes: h.nodes.length, endTicks: h.endTicks };
} catch (e) {
  out = { mode: "threw", message: String(e && e.message ? e.message : e).slice(0, 200) };
}
process.stdout.write("RESULT:" + JSON.stringify(out) + "\n");
