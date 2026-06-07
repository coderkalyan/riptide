#!/usr/bin/env bash
# Run the Electron visual-regression harness fully headless, with NO interaction
# with the user's real desktop session. Spins up a throwaway nested `sway`
# compositor on its headless wlroots backend (a virtual output, no monitor), runs
# the test inside it forcing Electron onto that nested Wayland display, then exits
# sway. Nothing appears on screen and the tiling WM never sees the window.
#
#   tests/e2e/run-headless.sh                 # compare against goldens
#   UPDATE_GOLDENS=1 tests/e2e/run-headless.sh    # (re)write goldens
#   TEST_ARGS='--test-name-pattern=loaded$' tests/e2e/run-headless.sh
#
# Requires `sway` on PATH (wlroots headless backend). The GPU canvas is masked in
# the harness, so the compositor's software (pixman) renderer is fine.
set -uo pipefail
cd "$(dirname "$0")/../.."

command -v sway >/dev/null || { echo "run-headless: sway not found on PATH" >&2; exit 127; }

RC_FILE=$(mktemp)
LOG_FILE=$(mktemp)
CFG_FILE=$(mktemp)
trap 'rm -f "$RC_FILE" "$LOG_FILE" "$CFG_FILE"' EXIT
echo 1 > "$RC_FILE" # default-fail until the inner command reports success

# Inside the nested compositor: force Electron onto the nested Wayland display
# (env -u DISPLAY stops it from leaking onto the outer X server / real screen),
# run the test (output → LOG_FILE since sway's own stdout is noisy/suppressed),
# record its exit code, then tear sway down.
cat > "$CFG_FILE" <<EOF
output HEADLESS-1 resolution 1920x1200
exec "env -u DISPLAY ELECTRON_OZONE_PLATFORM_HINT=wayland node --test ${TEST_ARGS:-} ${TARGET:-tests/e2e/visual.test.cjs} >$LOG_FILE 2>&1; echo \$? > $RC_FILE; swaymsg exit"
EOF

WLR_BACKENDS=headless \
WLR_RENDERER=pixman \
WLR_LIBINPUT_NO_DEVICES=1 \
  sway -c "$CFG_FILE" >/dev/null 2>&1

cat "$LOG_FILE"
exit "$(cat "$RC_FILE")"
