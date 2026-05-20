#!/usr/bin/env bash
#
# run-ticket.sh — Run Claude Code on a single ticket
#
# Project-agnostic: all repo/board configuration is passed via environment
# variables by the poller (poll-tickets.mts), not derived from filesystem position.
#
# Required env vars (set by poller):
#   REPO_PATH        — absolute path to the git repo (~ expanded)
#   WORKTREES_DIR    — absolute path to the worktrees directory
#   DEFAULT_BRANCH   — default branch name (e.g. master, main)
#   GITHUB_REPO      — owner/repo for gh commands (e.g. helloworld1812/workstream-mono)
#   IS_MONO          — "true" if repo is a monorepo
#   PROJECT_PATH     — path to the project's entry point within the repo (for monorepos)
#   SETUP_SYMLINK_NODE_MODULES — "true" to symlink node_modules
#   SETUP_INSTALL_COMMAND      — command to run if lockfile differs
#   SETUP_INSTALL_CHECK        — lockfile path to diff (e.g. pnpm-lock.yaml)
#   STATE_BACKLOG / STATE_TODO / STATE_IN_PROGRESS / STATE_HUMAN_REVIEW /
#   STATE_IN_REVIEW / STATE_REWORK / STATE_MERGING / STATE_DONE
#   SYMPHONY_ROOT    — path to ~/symphony
#   AGENT_RUNTIME    — "claude" (default) or "codex". Selected per-ticket by the
#                       poller from a `runtime:<name>` label or board defaultRuntime.
#
# Usage:
#   run-ticket.sh <ticket-id> <ticket-title> [ticket-description] [--fresh|--feedback]
#
# Modes (4th arg):
#   --fresh     New ticket from Todo — wipe old worktree, start clean.
#   --feedback  Ticket returned from review — reuse worktree, inject feedback prompt.
#   (omitted)   Poller restart — resume session with minimal continue prompt.

set -euo pipefail

# Re-exec via setsid(2) so this bash becomes a session+process-group leader.
# Without this, the script inherits the poller's PGID and `kill -- -$$` in the
# trap below would signal the poller itself. macOS does not ship setsid(1), so
# fall back to a one-liner using Python's POSIX bindings, which are always
# available wherever this codebase runs.
if [ -z "${SYMPHONY_NEW_SESSION:-}" ]; then
  # Pass the sentinel inline via `env` so it reaches the re-exec'd process but
  # is NOT exported to anything claude / the agent later spawns. Otherwise a
  # nested run-ticket.sh invocation would inherit `SYMPHONY_NEW_SESSION=1`,
  # skip the setsid bootstrap, and silently rejoin the parent's process group.
  if command -v setsid >/dev/null 2>&1; then
    exec env SYMPHONY_NEW_SESSION=1 setsid -w "$0" "$@"
  else
    exec env SYMPHONY_NEW_SESSION=1 /usr/bin/env python3 -c "import os, sys; os.setsid(); os.execvp(sys.argv[1], sys.argv[1:])" "$0" "$@"
  fi
fi
# Drop the sentinel as soon as the second-pass shell starts so children we
# spawn never see it either.
unset SYMPHONY_NEW_SESSION

# Cleanup: on INT/TERM/HUP/EXIT, signal every descendant in our process group.
# SIGKILL cannot be ignored, so we cannot use `kill -- -$$` / `kill 0` — that
# would kill this bash mid-trap and lose the agent exit code. Enumerate the
# group via pgrep and kill children individually (excluding $$). Order:
# SIGTERM, brief grace period, SIGKILL stragglers.
cleanup_process_group() {
  # When fired from a signal trap, $? inside the handler is the previous
  # command's status, not the canonical 128+N signal exit code. Each trap
  # passes the right value in explicitly so monitoring systems (and the
  # poller's `child.on('exit')` handler) see 130/143/129 instead of 0.
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

TICKET_ID="${1:?Usage: run-ticket.sh <ticket-id> <title> [description] [--fresh]}"
TICKET_TITLE="${2:?Usage: run-ticket.sh <ticket-id> <title> [description] [--fresh]}"
TICKET_DESC="${3:-(no description provided)}"
FRESH="${4:-}"

# ── Resolve paths ──────────────────────────────────────────────────────────────

SYMPHONY_ROOT="${SYMPHONY_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"
REPO_ROOT="${REPO_PATH:?REPO_PATH env var required}"
REPO_ROOT="${REPO_ROOT/#\~/$HOME}"  # expand ~
WORKTREES_DIR="${WORKTREES_DIR:?WORKTREES_DIR env var required}"
WORKTREES_DIR="${WORKTREES_DIR/#\~/$HOME}"
DEFAULT_BRANCH="${DEFAULT_BRANCH:-master}"
WORKFLOW_FILE="${HOME}/WORKFLOW.md"

SLUG="$(echo "$TICKET_TITLE" | tr '[:upper:]' '[:lower:]' | sed 's/[^a-z0-9]/-/g' | sed 's/--*/-/g' | cut -c1-40 | sed 's/-$//')"
BRANCH="feat/${TICKET_ID}-${SLUG}"
FOLDER="$(echo "$BRANCH" | tr '/' '--')"
WORKTREE_PATH="$WORKTREES_DIR/$FOLDER"

echo "══════════════════════════════════════"
echo "  Symphony Runner — ${TICKET_ID}"
echo "══════════════════════════════════════"
echo "  Title:    ${TICKET_TITLE}"
echo "  Branch:   ${BRANCH}"
echo "  Repo:     ${REPO_ROOT}"
echo "  Path:     ${WORKTREE_PATH}"
echo ""

# Wrap `git fetch` so SSH/DNS failures surface a useful hint instead of just
# exiting 128. Common case: a local proxy (Clash/Surge/Mihomo) returns a fakeIP
# for github.com but the chosen node doesn't proxy SSH (port 22) or is in a
# region that can't reach GitHub.
fetch_or_diagnose() {
  local branch="$1"
  local err
  if err="$(git fetch origin "$branch" --quiet 2>&1)"; then
    return 0
  fi
  printf '%s\n' "$err" >&2
  if echo "$err" | grep -qE 'Could not read from remote|Connection (closed|refused|timed out)|kex_exchange_identification|Network is unreachable'; then
    local ip
    ip="$(dig +short github.com 2>/dev/null | tail -n1)"
    if [ -n "$ip" ] && echo "$ip" | grep -qE '^(198\.1[89]\.|0\.|10\.|127\.|169\.254\.|172\.(1[6-9]|2[0-9]|3[01])\.|192\.168\.|240\.|fc|fd)'; then
      cat >&2 <<EOF

⚠ github.com 被解析到非公网 IP (${ip})。
  很可能是本地代理 (Clash/Surge/Mihomo 等) 用 fakeIP 接管了 DNS，
  但当前节点 / 规则不支持 GitHub SSH (22)，或所在地区无法访问 GitHub。

  尝试：
    1. 切换到一个能访问 GitHub 的代理节点；
    2. 在代理软件中把 github.com 加入直连或 SSH 代理规则；
    3. 或改用 SSH-over-HTTPS（在 ~/.ssh/config 中）：
         Host github.com
           Hostname ssh.github.com
           Port 443
           User git

EOF
    fi
  fi
  return 128
}

cd "$REPO_ROOT"
fetch_or_diagnose "$DEFAULT_BRANCH"

if [ "$FRESH" = "--fresh" ]; then
  if [ -d "$WORKTREE_PATH" ]; then
    rm -f "$WORKTREE_PATH/.claude-session-id"
    git worktree remove --force "$WORKTREE_PATH"
    echo "[run] Removed old worktree for fresh start."
  fi
  if git show-ref --verify --quiet "refs/heads/$BRANCH"; then
    git branch -D "$BRANCH"
    echo "[run] Deleted old branch for fresh start."
  fi
  echo "[run] Creating fresh worktree from origin/${DEFAULT_BRANCH}..."
  git worktree add "$WORKTREE_PATH" -b "$BRANCH" "refs/remotes/origin/${DEFAULT_BRANCH}"
elif [ -d "$WORKTREE_PATH" ]; then
  echo "[run] Worktree exists, reusing: ${WORKTREE_PATH}"
elif git show-ref --verify --quiet "refs/heads/$BRANCH"; then
  echo "[run] Branch exists, creating worktree from existing branch..."
  git worktree add "$WORKTREE_PATH" "$BRANCH"
else
  echo "[run] Creating worktree..."
  git worktree add "$WORKTREE_PATH" -b "$BRANCH" "refs/remotes/origin/${DEFAULT_BRANCH}"
fi

cd "$WORKTREE_PATH"

# Copy secrets to worktree so the agent has LINEAR_API_KEY etc.
if [ -f "$SYMPHONY_ROOT/secrets.env" ] && [ ! -f "$WORKTREE_PATH/secrets.env" ]; then
  cp "$SYMPHONY_ROOT/secrets.env" "$WORKTREE_PATH/secrets.env"
  echo "[run] Copied secrets.env to worktree."
fi

# Setup: symlink node_modules if needed
if [ "${SETUP_SYMLINK_NODE_MODULES:-}" = "true" ] && [ ! -e "$WORKTREE_PATH/node_modules" ]; then
  ln -s "$REPO_ROOT/node_modules" "$WORKTREE_PATH/node_modules"
  echo "[run] Symlinked node_modules from main repo."
fi

# Setup: run install if lockfile differs
if [ -n "${SETUP_INSTALL_CHECK:-}" ] && [ -n "${SETUP_INSTALL_COMMAND:-}" ]; then
  if ! git diff --quiet "refs/remotes/origin/${DEFAULT_BRANCH}" -- "$SETUP_INSTALL_CHECK" 2>/dev/null; then
    echo "[run] ${SETUP_INSTALL_CHECK} differs from origin/${DEFAULT_BRANCH} — running install..."
    eval "$SETUP_INSTALL_COMMAND"
  else
    echo "[run] Dependencies up to date, skipping install."
  fi
fi

# Rebase onto latest branch
fetch_or_diagnose "$DEFAULT_BRANCH"
if ! git rebase "refs/remotes/origin/${DEFAULT_BRANCH}" --quiet 2>/dev/null; then
  echo "[run] Rebase conflict — squashing local commits and retrying..."
  git rebase --abort 2>/dev/null || true
  BASE=$(git merge-base HEAD "refs/remotes/origin/${DEFAULT_BRANCH}")
  git reset --soft "$BASE"
  git add -A
  git commit --no-verify -m "squash: ${TICKET_ID} work in progress"
  git rebase "refs/remotes/origin/${DEFAULT_BRANCH}" || true
fi

echo "[run] Ready. Starting Claude Code..."
echo ""

# ── Export env vars for agent ──────────────────────────────────────────────────

export TICKET_ID TICKET_TITLE TICKET_DESC
export REPO_ROOT WORKTREE_PATH BRANCH
export SYMPHONY_ROOT
export SYMPHONY=true
export SKILLS_ROOT="${HOME}/.claude/skills"
export GITHUB_REPO="${GITHUB_REPO:-}"
export PROJECT_PATH="${PROJECT_PATH:-$REPO_ROOT}"
export DEFAULT_BRANCH

# Ticket system (from board config)
export TICKET_SYSTEM="${TICKET_SYSTEM:-linear}"

# State IDs (from board config, passed by poller)
export STATE_BACKLOG="${STATE_BACKLOG:-}"
export STATE_TODO="${STATE_TODO:-}"
export STATE_IN_PROGRESS="${STATE_IN_PROGRESS:-}"
export STATE_HUMAN_REVIEW="${STATE_HUMAN_REVIEW:-}"
export STATE_IN_REVIEW="${STATE_IN_REVIEW:-}"
export STATE_REWORK="${STATE_REWORK:-}"
export STATE_MERGING="${STATE_MERGING:-}"
export STATE_DONE="${STATE_DONE:-}"

# Language preferences (from symphony.json, passed by poller)
export PERSONAL_PREFERRED_LANGUAGE="${PERSONAL_PREFERRED_LANGUAGE:-Chinese (Simplified)}"
export WORK_PREFERRED_LANGUAGE="${WORK_PREFERRED_LANGUAGE:-English}"
export NEVER_USE_LANGUAGE="${NEVER_USE_LANGUAGE:-Korean or Japanese}"

AGENT_RUNTIME="${AGENT_RUNTIME:-claude}"
export AGENT_RUNTIME

case "$FRESH" in
  --fresh)
    export RUN_MODE="fresh start (from origin/${DEFAULT_BRANCH})"
    PROMPT="$(envsubst < "$WORKFLOW_FILE")"
    ;;
  --feedback)
    PROMPT="$(envsubst < "$SKILLS_ROOT/resume/feedback.md")"
    ;;
  *)
    PROMPT="$(envsubst < "$SKILLS_ROOT/resume/continue.md")"
    ;;
esac

# ── Spawn agent ────────────────────────────────────────────────────────────────

if [ "$AGENT_RUNTIME" = "codex" ]; then
  # codex tracks sessions independently of claude — no --session-id / --resume
  # plumbing on either branch. Each invocation is its own session.
  CODEX_BIN="${CODEX_BIN:-codex}"
  CODEX_FLAGS="${CODEX_FLAGS:---dangerously-bypass-approvals-and-sandbox}"
  if [ "${REMOTE_CONTROL:-}" = "true" ]; then
    # Use the interactive `codex` TUI (not `codex exec`) so the codex desktop
    # app can attach and surface session details. Poller redirects stdio to a
    # log file, so allocate a PTY for the TUI to render in.
    echo "[run] Runtime: codex TUI via pty (bin=$CODEX_BIN flags=$CODEX_FLAGS)"
    # shellcheck disable=SC2086
    PROMPT_FILE="$(mktemp /tmp/symphony-codex-prompt-XXXXXX.txt)"
    printf '%s' "$PROMPT" > "$PROMPT_FILE"
    CODEX_BIN="$CODEX_BIN" python3 "$SYMPHONY_ROOT/scripts/codex-pty-wrapper.py" "$PROMPT_FILE" $CODEX_FLAGS
  else
    echo "[run] Runtime: codex exec (bin=$CODEX_BIN flags=$CODEX_FLAGS)"
    # shellcheck disable=SC2086
    "$CODEX_BIN" exec $CODEX_FLAGS "$PROMPT"
  fi
  AGENT_EXIT=$?
else
  SESSION_ID_FILE="${WORKTREE_PATH}/.claude-session-id"

  # Claude derives the on-disk project dir from the worktree path by replacing
  # every "/" with "-" and prepending "-". The session jsonl lives at
  # ~/.claude/projects/<project-dir>/<session-id>.jsonl. Claude may garbage-collect
  # that jsonl (or the whole project dir) without touching our pointer file, in
  # which case `claude --resume <id>` prints "No conversation found" and exits 0
  # immediately. Detect that case here and fall back to creating a new session.
  CLAUDE_PROJECT_DIR="${HOME}/.claude/projects/$(echo "$WORKTREE_PATH" | tr '/' '-')"

  session_jsonl_exists() {
    local id="$1"
    [ -f "${CLAUDE_PROJECT_DIR}/${id}.jsonl" ]
  }

  START_NEW_SESSION=0
  if [ "$FRESH" = "--fresh" ] || [ ! -f "$SESSION_ID_FILE" ]; then
    START_NEW_SESSION=1
  else
    SESSION_ID=$(cat "$SESSION_ID_FILE")
    if ! session_jsonl_exists "$SESSION_ID"; then
      echo "[run] Pointer file references session ${SESSION_ID} but ${CLAUDE_PROJECT_DIR}/${SESSION_ID}.jsonl is gone — starting a new session."
      START_NEW_SESSION=1
    fi
  fi

  SESSION_ARGS=()
  if [ "$START_NEW_SESSION" = "1" ]; then
    SESSION_ID=$(python3 -c "import uuid; print(uuid.uuid4())")
    echo "$SESSION_ID" > "$SESSION_ID_FILE"
    SESSION_ARGS=(--session-id "$SESSION_ID")
  else
    SESSION_ARGS=(--resume "$SESSION_ID")
  fi

  if [ "${REMOTE_CONTROL:-}" = "true" ]; then
    PROMPT_FILE="$(mktemp /tmp/symphony-prompt-XXXXXX.txt)"
    printf '%s' "$PROMPT" > "$PROMPT_FILE"
    python3 "$SYMPHONY_ROOT/scripts/pty-wrapper.py" "$PROMPT_FILE" "${SESSION_ARGS[@]}"
  else
    NAME_ARGS=()
    if [ "$START_NEW_SESSION" = "1" ]; then
      SESSION_SLUG="${BRANCH#feat/${TICKET_ID}-}"
      NAME_ARGS=(--name "[${TICKET_ID}] ${SESSION_SLUG}")
    fi
    claude --dangerously-skip-permissions "${SESSION_ARGS[@]}" "${NAME_ARGS[@]}" --print "$PROMPT"
  fi
  AGENT_EXIT=$?
fi

echo ""
if [ $AGENT_EXIT -eq 0 ]; then
  echo "[run] ✓ ${AGENT_RUNTIME} finished: ${TICKET_ID}"
elif [ $AGENT_EXIT -eq 130 ] || [ $AGENT_EXIT -eq 143 ]; then
  echo "[run] ⚠ ${AGENT_RUNTIME} interrupted (signal ${AGENT_EXIT}): ${TICKET_ID}" >&2
else
  echo "[run] ✗ ${AGENT_RUNTIME} exited with error (code ${AGENT_EXIT}): ${TICKET_ID}" >&2
fi
exit $AGENT_EXIT
