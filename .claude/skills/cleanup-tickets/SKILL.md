---
name: cleanup-tickets
description: Sweep local worktrees and branches across all repos, detect merged PRs, transition tickets to Done, and delete stale local/remote branches. Run this to recover from tickets stuck in Merging or to bulk-clean up after a sprint. Works against Linear (`WOR-*`), Jira (`UP-*`), and GitHub Projects (e.g. `SY-*`) boards via the ticket dispatcher.
---

# Cleanup Tickets

Scans all repos for local branches/worktrees that contain a ticket ID, checks each ticket's state and PR state, and cleans up anything that has already been merged.

> **When to use:** After a batch of PRs were merged without Symphony detecting them (e.g. the ticket system wasn't connected to GitHub, or the poller was down), run this skill to reconcile state.

All ticket reads/writes go through `$SKILLS_ROOT/ticket/SKILL.md` — do not call Linear, Jira, or GitHub APIs directly. The dispatcher routes to the matching sub-skill based on each board's `ticketSystem`.

---

## Step 1 — Load board configs

Read every board config to get the repo list and the ticket system for each board:

```bash
ls $SYMPHONY_ROOT/config/boards/
```

For each board config (e.g. `wor.json`, `up.json`), note:

- `ticketPrefix` (e.g. `WOR`, `UP`) — used to match branch names and to set the per-board `$TICKET_SYSTEM` when invoking the dispatcher
- `ticketSystem` — `linear`, `jira`, or `github-projects`
- `repos[]` — each entry has `path`, `worktreesDir`, `defaultBranch`, `githubRepo`
- The `Done` state identifier: `linear.states.done` (Linear UUID), `jira.states.done` + `jira.transitions.done` (Jira name and numeric transition ID), or `githubProjects.states.done` (ProjectV2 option name)

Export `TICKET_SYSTEM` to match the board you are processing before each ticket-system call — the dispatcher reads it.

---

## Step 2 — Enumerate candidate branches

For each repo in the board, collect branches in two ways:

### 2a — Worktree directories

```bash
ls "$WORKTREES_DIR" 2>/dev/null
```

Match folder names like `feat--<PREFIX>-XX-*` or `fix--<PREFIX>-XX-*` (use the board's `ticketPrefix`). Extract the ticket identifier (e.g. `WOR-44`, `UP-789`).

### 2b — Local git branches

```bash
git -C "$REPO_PATH" branch --list 'feat/*' --format='%(refname:short)'
```

Extract any branch whose name contains a ticket ID pattern (`[A-Z]+-\d+`).

Deduplicate — a ticket may appear in both lists.

---

## Step 3 — For each candidate ticket, check state

### 3a — Check ticket state through the dispatcher

Set `TICKET_ID` to the candidate, set `TICKET_SYSTEM` to the matching board's `ticketSystem`, then read `$SKILLS_ROOT/ticket/SKILL.md` and follow the sub-skill's "Get ticket details" intent:

- **Linear** → `mcp__linear-server__get_issue id=$TICKET_ID` (curl fallback in `$SKILLS_ROOT/linear/SKILL.md`)
- **Jira** → `mcp__mcp-atlassian__jira_get_issue issue_key=$TICKET_ID` (curl fallback in `$SKILLS_ROOT/jira/SKILL.md`)
- **GitHub Projects** → `mcp__github__issue_read method=get` against the issue number embedded in `$TICKET_ID` (see `$SKILLS_ROOT/github-projects/SKILL.md`). The ticket's *state* lives on the ProjectV2 item, not the issue — read the Status field via GraphQL.

Skip tickets already in **Done** state — they just need worktree cleanup (Step 4), no ticket update needed.

### 3b — Check GitHub PR state

```bash
# Check for any open PR first — if one exists, the ticket is still active
gh pr list --repo "$GITHUB_REPO" --head "$BRANCH" --state open --json number --limit 1

# Check for a merged PR with this branch head
gh pr list --repo "$GITHUB_REPO" --head "$BRANCH" --state merged --json number,mergedAt --limit 1
```

**A ticket is safe to finalize only if:**
- There are **no open PRs** for the branch, AND
- At least one **merged PR** exists for the branch

If an open PR exists, skip this ticket — it is still in active review.

---

## Step 4 — Act based on state

| Ticket state | PR state   | Action                                          |
|--------------|-----------|-------------------------------------------------|
| Done         | any       | Clean up worktree + local branch only           |
| Merging      | merged    | Move ticket to Done, clean up worktree + branch |
| In Review    | merged    | Move ticket to Done, clean up worktree + branch |
| any          | merged    | Move ticket to Done, clean up worktree + branch |
| any          | not merged| Skip — ticket is still active                   |

### Move ticket to Done

Read `$SKILLS_ROOT/ticket/SKILL.md` and pass the symbolic state `Done` (or `$STATE_DONE`, which holds the system-specific identifier — Linear UUID or Jira status name) to the matching sub-skill:

- **Linear** → `mcp__linear-server__update_issue id=$TICKET_ID state="Done"`
- **Jira** → list transitions via `mcp__mcp-atlassian__jira_get_transitions`, pick the one whose target status name matches `Done`, then `mcp__mcp-atlassian__jira_transition_issue`. The numeric transition ID is also cached in the board config under `jira.transitions.done`.
- **GitHub Projects** → no MCP equivalent. Use the ProjectV2 `updateProjectV2ItemFieldValue` GraphQL mutation with the `Done` option id (see `$SKILLS_ROOT/github-projects/SKILL.md`).

### Clean up worktree

```bash
# Remove worktree
git -C "$REPO_PATH" worktree remove --force "$WORKTREE_PATH" 2>/dev/null || true
git -C "$REPO_PATH" worktree prune

# Delete local branch (if exists)
git -C "$REPO_PATH" branch -D "$BRANCH" 2>/dev/null || true

# Delete remote branch (if exists)
git -C "$REPO_PATH" push origin --delete "$BRANCH" 2>/dev/null || true
```

---

## Step 5 — Report

After processing all repos, print a summary table:

```
Ticket   | Repo           | Action taken
---------|----------------|---------------------------
WOR-44   | claude-home    | Moved to Done, cleaned up
WOR-52   | workstream-hr  | Already Done, cleaned up
UP-789   | workstream-mono| Moved to Done, cleaned up
WOR-XX   | ...            | Skipped (PR not merged)
```

---

## Running against specific branches

If you want to target only specific branches (e.g. from the ticket's AC list), set them explicitly:

```bash
BRANCHES=(
  "feat/WOR-44-linear-template-skill"
  "feat/WOR-52-ai-code-review-should-respect-the-board"
  "feat/UP-789-symphony-poller-sigkill-claude-nx-daemon"
)
```

Then run Steps 3–4 for each branch, looking up the ticket ID from the branch name (the part after `feat/` up to the second `-`). Resolve the matching board from the prefix to pick the right `ticketSystem` before the ticket-system call.

---

## Notes

- This skill is safe to run multiple times — it skips tickets already in Done state.
- Always prefer `--force` when removing worktrees (they contain `.claude-session-id` which is untracked by design).
- If a worktree directory is missing but the git reference still exists, `git worktree prune` cleans it up.
- If `$STATE_DONE` is not set in the environment (the env vars are only set when the poller spawned the session), look it up from `$SYMPHONY_ROOT/config/boards/<board>.json` — `linear.states.done` for Linear boards, `jira.states.done` and `jira.transitions.done` for Jira boards, `githubProjects.states.done` for github-projects boards.
