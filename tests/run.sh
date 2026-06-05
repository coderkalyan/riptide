#!/usr/bin/env bash
# Regression/integration runner for riptide against the vcd-tests oracle corpus.
#
#   tests/run.sh            # node suites (headless) + e2e if a display exists
#   tests/run.sh native     # one suite: native | format | malformed | e2e
#
# Env:
#   VCD_TESTS_DIR   path to the vcd-tests checkout (default ~/Documents/vcd-tests)
#   SKIP_E2E=1      never run the Electron e2e (it needs a display / GPU)
#
# The three node suites are fully headless and CI-ready. The e2e suite drives the
# real Electron app and needs an X display (no xvfb here — run under a display, or
# install xvfb and wrap with `xvfb-run -a`). Exit code is nonzero if any suite
# fails (known riptide bugs currently fail — see tests/README.md).
set -uo pipefail
cd "$(dirname "$0")/.."

run_seam_a()       { ( cd native && zig build test ); }
run_native()       { node --test tests/native.test.cjs; }
run_format()       { node --test tests/format.test.cjs; }
run_differential() { node --test tests/differential.test.cjs; }
run_malformed()    { node --test tests/malformed.test.cjs; }
run_e2e() {
  if [[ "${SKIP_E2E:-}" == "1" ]]; then echo "e2e: skipped (SKIP_E2E=1)"; return 0; fi
  if [[ -z "${DISPLAY:-}" ]]; then echo "e2e: skipped (no DISPLAY — needs a display or xvfb)"; return 0; fi
  node --test tests/e2e/app.test.cjs
}

rc=0
case "${1:-all}" in
  seam-a)       run_seam_a       || rc=$? ;;
  native)       run_native       || rc=$? ;;
  format)       run_format       || rc=$? ;;
  differential) run_differential || rc=$? ;;
  malformed)    run_malformed    || rc=$? ;;
  e2e)          run_e2e          || rc=$? ;;
  all)
    run_seam_a       || rc=$?
    run_native       || rc=$?
    run_format       || rc=$?
    run_differential || rc=$?
    run_malformed    || rc=$?
    run_e2e          || rc=$?
    ;;
  *) echo "unknown suite: $1" >&2; exit 2 ;;
esac
exit $rc
