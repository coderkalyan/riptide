// Dumps the old Zig addon's getHierarchy() output as JSON — the differential
// oracle for riptide-core's TraceDb::hierarchy_dto (regenerates
// crates/riptide-core/tests/fixtures/zig_hierarchy_mock.json).
//
// Usage: node scripts/dump-hier.cjs [addon.node] [trace.vcd] [out.json]
// Defaults: dist/native/riptide.node (run `pnpm build:native` first),
// native/src/mock.vcd, the fixture path above.
const path = require("node:path");
const fs = require("node:fs");

const root = path.resolve(__dirname, "..");
const addonPath = path.resolve(process.argv[2] ?? path.join(root, "dist/native/riptide.node"));
const vcdPath = path.resolve(process.argv[3] ?? path.join(root, "native/src/mock.vcd"));
const outPath = path.resolve(
  process.argv[4] ?? path.join(root, "crates/riptide-core/tests/fixtures/zig_hierarchy_mock.json"),
);

const addon = require(addonPath);
addon.loadVcd(vcdPath);
fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, JSON.stringify(addon.getHierarchy(), null, 2) + "\n");
console.log(`wrote ${outPath}`);
