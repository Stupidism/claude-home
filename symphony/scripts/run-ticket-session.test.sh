#!/usr/bin/env bash
#
# Smoke test for the stale-session detection in run-ticket.sh.
#
# Reproduces the decision block from run-ticket.sh against a temp HOME and
# asserts that:
#   1) Missing pointer file → start new session.
#   2) Pointer file present + jsonl present → resume.
#   3) Pointer file present + jsonl missing → start new session (UP-751 fix).
#   4) --fresh always starts new session even if both files exist.

set -euo pipefail

FAIL=0
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# Decide START_NEW_SESSION the same way run-ticket.sh does. Kept in sync by
# hand — if the production block changes shape, update this and the assertions.
decide() {
  local fresh="$1"
  local worktree_path="$2"
  local home_dir="$3"
  local session_id_file="${worktree_path}/.claude-session-id"
  local claude_project_dir="${home_dir}/.claude/projects/$(echo "$worktree_path" | tr '/' '-')"

  local start_new_session=0
  if [ "$fresh" = "--fresh" ] || [ ! -f "$session_id_file" ]; then
    start_new_session=1
  else
    local session_id
    session_id=$(cat "$session_id_file")
    if [ ! -f "${claude_project_dir}/${session_id}.jsonl" ]; then
      start_new_session=1
    fi
  fi
  echo "$start_new_session"
}

assert_eq() {
  local label="$1" expected="$2" actual="$3"
  if [ "$expected" = "$actual" ]; then
    echo "  ✓ $label"
  else
    echo "  ✗ $label — expected '$expected', got '$actual'" >&2
    FAIL=1
  fi
}

WT="$TMP/worktree"
HOME_DIR="$TMP/home"
PROJECT_DIR="${HOME_DIR}/.claude/projects/$(echo "$WT" | tr '/' '-')"
mkdir -p "$WT" "$PROJECT_DIR"

echo "case 1: missing pointer file → new session"
assert_eq "no pointer" 1 "$(decide '' "$WT" "$HOME_DIR")"

echo "case 2: pointer + jsonl present → resume"
SID="11111111-1111-1111-1111-111111111111"
echo "$SID" > "$WT/.claude-session-id"
: > "${PROJECT_DIR}/${SID}.jsonl"
assert_eq "resume when jsonl exists" 0 "$(decide '' "$WT" "$HOME_DIR")"

echo "case 3: pointer present but jsonl gone → new session"
rm "${PROJECT_DIR}/${SID}.jsonl"
assert_eq "stale pointer triggers new session" 1 "$(decide '' "$WT" "$HOME_DIR")"

echo "case 4: --fresh forces new session even with both files"
: > "${PROJECT_DIR}/${SID}.jsonl"
assert_eq "--fresh always new" 1 "$(decide '--fresh' "$WT" "$HOME_DIR")"

if [ "$FAIL" -eq 0 ]; then
  echo "All cases passed."
else
  echo "Some cases failed." >&2
  exit 1
fi
