"use strict";
// Locate the vcd-tests fixture/oracle corpus and load oracle JSON.
//
// Override the corpus location with VCD_TESTS_DIR; defaults to a sibling
// ~/Documents/vcd-tests checkout.

const fs = require("node:fs");
const path = require("node:path");

const VCD_TESTS_DIR =
  process.env.VCD_TESTS_DIR ||
  path.join(process.env.HOME || "", "Documents", "vcd-tests");

const ORACLE_DIR = path.join(VCD_TESTS_DIR, "oracle");
const ADDON_PATH = path.join(__dirname, "..", "..", "dist", "native", "riptide.node");

function listOracles() {
  if (!fs.existsSync(ORACLE_DIR)) {
    throw new Error(
      `oracle dir not found: ${ORACLE_DIR} (set VCD_TESTS_DIR to the vcd-tests checkout)`,
    );
  }
  return fs
    .readdirSync(ORACLE_DIR)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => loadOracle(path.join(ORACLE_DIR, f)));
}

function loadOracle(file) {
  const o = JSON.parse(fs.readFileSync(file, "utf8"));
  // o.file is relative to the vcd-tests root.
  o._vcdPath = path.join(VCD_TESTS_DIR, o.file);
  return o;
}

function loadAddon() {
  if (!fs.existsSync(ADDON_PATH)) {
    throw new Error(`addon not built: ${ADDON_PATH} (run \`pnpm build:native\`)`);
  }
  // Fresh require each process; the addon caches one trace globally via loadVcd.
  return require(ADDON_PATH);
}

module.exports = { VCD_TESTS_DIR, ORACLE_DIR, ADDON_PATH, listOracles, loadOracle, loadAddon };
