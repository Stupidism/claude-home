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
#
# Usage:
#   run-ticket.sh <ticket-id> <ticket-title> [ticket-description] [--fresh|--feedback]
#
# Modes (4th arg):
#   --fresh     New ticket from Todo — wipe old worktree, start clean.
#   --feedback  Ticket returned from review — reuse worktree, inject feedback prompt.
#   (omitted)   Poller restart — resume session with minimal continue prompt.

set -euo pipefail

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

cd "$REPO_ROOT"
git fetch origin "$DEFAULT_BRANCH" --quiet

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
git fetch origin "$DEFAULT_BRANCH" --quiet
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

# ── Session management ─────────────────────────────────────────────────────────

SESSION_ID_FILE="${WORKTREE_PATH}/.claude-session-id"

if [ "$FRESH" = "--fresh" ] || [ ! -f "$SESSION_ID_FILE" ]; then
  SESSION_ID=$(python3 -c "import uuid; print(uuid.uuid4())")
  echo "$SESSION_ID" > "$SESSION_ID_FILE"
  SESSION_FLAG="--session-id $SESSION_ID"
else
  SESSION_ID=$(cat "$SESSION_ID_FILE")
  SESSION_FLAG="--resume $SESSION_ID"
fi

# ── Spawn agent ────────────────────────────────────────────────────────────────

if [ "${REMOTE_CONTROL:-}" = "true" ]; then
PROMPT_FILE="$(mktemp /tmp/symphony-prompt-XXXXXX.txt)"
  printf '%s' "$PROMPT" > "$PROMPT_FILE"
  python3 "$SYMPHONY_ROOT/scripts/pty-wrapper.py" "$PROMPT_FILE" $SESSION_FLAG
else
  SESSION_SLUG="${BRANCH#feat/${TICKET_ID}-}"
  if echo "$SESSION_FLAG" | grep -q -- '--session-id'; then
    NAME_FLAG="--name [${TICKET_ID}] ${SESSION_SLUG}"
  else
    NAME_FLAG=""
  fi
  claude --dangerously-skip-permissions $SESSION_FLAG $NAME_FLAG --print "$PROMPT"
fi
CLAUDE_EXIT=$?

echo ""
if [ $CLAUDE_EXIT -eq 0 ]; then
  echo "[run] ✓ Claude Code finished: ${TICKET_ID}"
elif [ $CLAUDE_EXIT -eq 130 ] || [ $CLAUDE_EXIT -eq 143 ]; then
  echo "[run] ⚠ Claude Code interrupted (signal ${CLAUDE_EXIT}): ${TICKET_ID}" >&2
else
  echo "[run] ✗ Claude Code exited with error (code ${CLAUDE_EXIT}): ${TICKET_ID}" >&2
fi
exit $CLAUDE_EXIT
