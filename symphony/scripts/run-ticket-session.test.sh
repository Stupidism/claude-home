#!/usr/bin/env bash
#
# Smoke test for the session-resume detection in run-ticket.sh.
#
# Reproduces the decision block from run-ticket.sh against a temp HOME and
# asserts that START_NEW_SESSION is chosen correctly across runtimes/modes:
#   plain claude (jsonl probe):
#     1) Missing pointer file → start new session.
#     2) Pointer + jsonl present → resume.
#     3) Pointer present + jsonl missing → start new session (UP-751 fix).
#     4) --fresh always starts new session even if both files exist.
#   remote-control claude (session-env probe, UP-839):
#     5) Pointer + session-env dir present → resume (jsonl is never written).
#     6) Pointer present + session-env dir missing → start new session.
#   codex (no resume plumbing, UP-839):
#     7) Pointer present → still start new session (context never survives).

set -euo pipefail

FAIL=0
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# Decide START_NEW_SESSION the same way run-ticket.sh does. Kept in sync by
# hand — if the production block changes shape, update this and the assertions.
#   $1 fresh           "--fresh" or ""
#   $2 worktree_path
#   $3 home_dir
#   $4 agent_runtime   "claude" (default) or "codex"
#   $5 remote_control  "true" or "" (default)
decide() {
  local fresh="$1"
  local worktree_path="$2"
  local home_dir="$3"
  local agent_runtime="${4:-claude}"
  local remote_control="${5:-}"
  local session_id_file="${worktree_path}/.claude-session-id"
  local claude_project_dir="${home_dir}/.claude/projects/$(echo "$worktree_path" | tr '/' '-')"

  session_context_survives() {
    local id="$1"
    if [ "$agent_runtime" = "codex" ]; then
      return 1
    elif [ "$remote_control" = "true" ]; then
      [ -d "${home_dir}/.claude/session-env/${id}" ]
    else
      [ -f "${claude_project_dir}/${id}.jsonl" ]
    fi
  }

  local start_new_session=0
  if [ "$fresh" = "--fresh" ] || [ ! -f "$session_id_file" ]; then
    start_new_session=1
  else
    local session_id
    session_id=$(cat "$session_id_file")
    if ! session_context_survives "$session_id"; then
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
SESSION_ENV_DIR="${HOME_DIR}/.claude/session-env"
mkdir -p "$WT" "$PROJECT_DIR" "$SESSION_ENV_DIR"

SID="11111111-1111-1111-1111-111111111111"

echo "case 1: missing pointer file → new session"
assert_eq "no pointer" 1 "$(decide '' "$WT" "$HOME_DIR")"

echo "case 2: pointer + jsonl present → resume"
echo "$SID" > "$WT/.claude-session-id"
: > "${PROJECT_DIR}/${SID}.jsonl"
assert_eq "resume when jsonl exists" 0 "$(decide '' "$WT" "$HOME_DIR")"

echo "case 3: pointer present but jsonl gone → new session"
rm "${PROJECT_DIR}/${SID}.jsonl"
assert_eq "stale pointer triggers new session" 1 "$(decide '' "$WT" "$HOME_DIR")"

echo "case 4: --fresh forces new session even with both files"
: > "${PROJECT_DIR}/${SID}.jsonl"
assert_eq "--fresh always new" 1 "$(decide '--fresh' "$WT" "$HOME_DIR")"

# UP-839: remote-control never writes the project jsonl, so the jsonl probe is
# a guaranteed false negative. With a session-env dir present, resume must win.
echo "case 5: remote-control pointer + session-env dir present → resume"
rm -f "${PROJECT_DIR}/${SID}.jsonl"   # jsonl absent, as it always is under remote-control
mkdir -p "${SESSION_ENV_DIR}/${SID}"
assert_eq "remote-control resumes via session-env" 0 "$(decide '' "$WT" "$HOME_DIR" claude true)"

echo "case 6: remote-control pointer + session-env dir missing → new session"
rm -rf "${SESSION_ENV_DIR:?}/${SID:?}"
assert_eq "remote-control new session when session-env gone" 1 "$(decide '' "$WT" "$HOME_DIR" claude true)"

# UP-839: codex has no resume plumbing — context never survives a restart.
echo "case 7: codex pointer present → still new session"
mkdir -p "${SESSION_ENV_DIR}/${SID}"
: > "${PROJECT_DIR}/${SID}.jsonl"
assert_eq "codex never resumes" 1 "$(decide '' "$WT" "$HOME_DIR" codex)"

if [ "$FAIL" -eq 0 ]; then
  echo "All cases passed."
else
  echo "Some cases failed." >&2
  exit 1
fi
