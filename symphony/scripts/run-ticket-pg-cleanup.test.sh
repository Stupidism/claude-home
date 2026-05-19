#!/usr/bin/env bash
#
# Smoke test for the setsid + trap cleanup in run-ticket.sh (UP-789).
#
# Verifies:
#   1) After the setsid trampoline, bash's PGID equals its PID — i.e. it is a
#      session/process-group leader, so `kill -- -$$` in the trap is safe.
#   2) When the script receives SIGTERM, its descendant `sleep` processes are
#      reaped within a few seconds (no orphans left behind for launchd).
#   3) When the script exits cleanly, descendants also get reaped (EXIT trap).

set -euo pipefail

FAIL=0
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# A tiny script that mimics run-ticket.sh: setsid trampoline, trap, then spawn
# a long-running child and wait. Kept inline so the test runs against the
# production setsid+trap snippet too — copy-paste keeps them in lockstep with
# the version in run-ticket.sh; if the production block changes shape, update
# this fixture and the assertions.
cat > "$TMP/fixture.sh" <<'FIX'
#!/usr/bin/env bash
set -euo pipefail
if [ -z "${FIXTURE_NEW_SESSION:-}" ]; then
  if command -v setsid >/dev/null 2>&1; then
    exec env FIXTURE_NEW_SESSION=1 setsid -w "$0" "$@"
  else
    exec env FIXTURE_NEW_SESSION=1 /usr/bin/env python3 -c "import os, sys; os.setsid(); os.execvp(sys.argv[1], sys.argv[1:])" "$0" "$@"
  fi
fi
unset FIXTURE_NEW_SESSION
cleanup_process_group() {
  local exit_code="${1:-$?}"
  trap '' INT TERM HUP
  trap - EXIT
  local victims
  victims="$(pgrep -g $$ 2>/dev/null | grep -vx $$ || true)"
  if [ -n "$victims" ]; then
    # shellcheck disable=SC2086
    kill -TERM $victims 2>/dev/null || true
    for _ in 1 2 3 4 5 6 7 8 9 10; do
      victims="$(pgrep -g $$ 2>/dev/null | grep -vx $$ || true)"
      [ -z "$victims" ] && break
      sleep 0.5
    done
    victims="$(pgrep -g $$ 2>/dev/null | grep -vx $$ || true)"
    if [ -n "$victims" ]; then
      # shellcheck disable=SC2086
      kill -KILL $victims 2>/dev/null || true
    fi
  fi
  exit "$exit_code"
}
trap 'cleanup_process_group 130' INT
trap 'cleanup_process_group 143' TERM
trap 'cleanup_process_group 129' HUP
trap 'cleanup_process_group $?' EXIT

# Record PGID so the test can validate setsid worked.
ps -o pgid= -p $$ | tr -d ' ' > "$1/pgid"
echo $$ > "$1/pid"

# Spawn two long-lived descendants and let their PIDs leak to the test.
sleep 60 &
echo $! > "$1/child1"
sleep 60 &
echo $! > "$1/child2"

# Mode 2 = exit cleanly after the children are recorded.
if [ "${2:-wait}" = "exit-clean" ]; then
  exit 0
fi
wait
FIX
chmod +x "$TMP/fixture.sh"

assert_eq() {
  local label="$1" expected="$2" actual="$3"
  if [ "$expected" = "$actual" ]; then
    echo "  ✓ $label"
  else
    echo "  ✗ $label — expected '$expected', got '$actual'" >&2
    FAIL=1
  fi
}

assert_dead() {
  local label="$1" pid="$2"
  if kill -0 "$pid" 2>/dev/null; then
    echo "  ✗ $label — PID $pid still alive" >&2
    FAIL=1
  else
    echo "  ✓ $label (PID $pid gone)"
  fi
}

# ── Test 1: SIGTERM cleans up descendants ───────────────────────────────────
echo "test: SIGTERM on parent reaps the whole process group"
WORK="$TMP/work1"; mkdir -p "$WORK"
"$TMP/fixture.sh" "$WORK" wait &
PARENT_PID=$!

# Wait until the fixture has spawned both children.
for _ in 1 2 3 4 5 6 7 8 9 10; do
  [ -f "$WORK/child2" ] && break
  sleep 0.2
done
[ -f "$WORK/child2" ] || { echo "  ✗ fixture never wrote child PIDs" >&2; FAIL=1; }

FIXTURE_PID="$(cat "$WORK/pid" 2>/dev/null || echo 0)"
FIXTURE_PGID="$(cat "$WORK/pgid" 2>/dev/null || echo 0)"
CHILD1="$(cat "$WORK/child1" 2>/dev/null || echo 0)"
CHILD2="$(cat "$WORK/child2" 2>/dev/null || echo 0)"

assert_eq "fixture bash is its own PGID leader" "$FIXTURE_PID" "$FIXTURE_PGID"

kill -TERM "$FIXTURE_PID"
# Capture exit status — must be 143 (128 + SIGTERM=15). Bash zeroes $? if the
# trap does not propagate the signal code explicitly, which would let killed
# runs look successful to the poller; this is the UP-789 CodeRabbit catch.
set +e
wait "$PARENT_PID"
FIXTURE_STATUS=$?
set -e
assert_eq "fixture preserves SIGTERM exit code (143)" "143" "$FIXTURE_STATUS"

# Give the trap up to 6s to reap (it allows 10*0.5s = 5s plus a small margin).
for _ in 1 2 3 4 5 6 7 8 9 10 11 12; do
  if ! kill -0 "$CHILD1" 2>/dev/null && ! kill -0 "$CHILD2" 2>/dev/null; then
    break
  fi
  sleep 0.5
done
assert_dead "child1 reaped after SIGTERM" "$CHILD1"
assert_dead "child2 reaped after SIGTERM" "$CHILD2"

# ── Test 2: clean exit also runs the EXIT trap ───────────────────────────────
echo "test: clean exit reaps descendants via the EXIT trap"
WORK="$TMP/work2"; mkdir -p "$WORK"
"$TMP/fixture.sh" "$WORK" exit-clean &
PARENT_PID=$!
wait "$PARENT_PID" 2>/dev/null || true

CHILD1="$(cat "$WORK/child1" 2>/dev/null || echo 0)"
CHILD2="$(cat "$WORK/child2" 2>/dev/null || echo 0)"

for _ in 1 2 3 4 5 6 7 8 9 10 11 12; do
  if ! kill -0 "$CHILD1" 2>/dev/null && ! kill -0 "$CHILD2" 2>/dev/null; then
    break
  fi
  sleep 0.5
done
assert_dead "child1 reaped after clean exit" "$CHILD1"
assert_dead "child2 reaped after clean exit" "$CHILD2"

if [ "$FAIL" -ne 0 ]; then
  echo "FAIL"
  exit 1
fi
echo "PASS"
