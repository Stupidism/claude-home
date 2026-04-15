---
name: cleanup-tickets
description: Sweep local worktrees and branches across all repos, detect merged PRs, move tickets to Done, and delete stale local/remote branches. Run this to recover from tickets stuck in Merging or to bulk-clean up after a sprint.
---

# Cleanup Tickets

Scans all repos for local branches/worktrees that contain a ticket ID, checks their PR and Linear state, and cleans up anything that has already been merged.

> **When to use:** After a batch of PRs were merged without Symphony detecting them (e.g. Linear wasn't connected to GitHub, or the poller was down), run this skill to reconcile state.

---

## Step 1 — Load board configs

Read all board config files to get the repo list:

```bash
ls $SYMPHONY_ROOT/config/boards/
```

For each board config (e.g. `wor.json`), note the `repos[]` array — each entry has `path`, `worktreesDir`, `defaultBranch`, and `github`.

Also note the board's `states.done` UUID for Linear transitions.

---

## Step 2 — Enumerate candidate branches

For each repo in the board, collect branches in two ways:

### 2a — Worktree directories

```bash
ls "$WORKTREES_DIR" 2>/dev/null
```

Match folder names like `feat--WOR-XX-*` or `fix--WOR-XX-*`. Extract the ticket identifier (e.g. `WOR-44`).

### 2b — Local git branches

```bash
git -C "$REPO_PATH" branch --list 'feat/*' --format='%(refname:short)'
```

Extract any branch whose name contains a ticket ID pattern (`[A-Z]+-\d+`).

Deduplicate — a ticket may appear in both lists.

---

## Step 3 — For each candidate ticket, check state

### 3a — Check Linear ticket state

```bash
node << 'EOF'
const https = require('https');
const ticketId = process.env.TICKET_ID;
const body = JSON.stringify({
  query: `{ issue(id: "${ticketId}") { id state { name } title } }`
});
const req = https.request({
  hostname: 'api.linear.app', path: '/graphql', method: 'POST',
  headers: { Authorization: process.env.LINEAR_API_KEY, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
}, (res) => {
  let d = ''; res.on('data', c => d += c);
  res.on('end', () => {
    const r = JSON.parse(d);
    const issue = r.data?.issue;
    if (!issue) { console.log('NOT_FOUND'); return; }
    console.log(issue.state.name);
  });
});
req.write(body); req.end();
EOF
```

Skip tickets already in **Done** state — they just need worktree cleanup (Step 4), no Linear update needed.

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

| Linear state | PR state  | Action                                      |
|-------------|-----------|---------------------------------------------|
| Done        | any       | Clean up worktree + local branch only       |
| Merging     | merged    | Move ticket to Done, clean up worktree + branch |
| In Review   | merged    | Move ticket to Done, clean up worktree + branch |
| any         | merged    | Move ticket to Done, clean up worktree + branch |
| any         | not merged| Skip — ticket is still active               |

### Move ticket to Done

```bash
node << 'EOF'
const https = require('https');
// Step 1: get UUID
const getBody = JSON.stringify({ query: `{ issue(id: "${process.env.TICKET_ID}") { id } }` });
const req = https.request({
  hostname: 'api.linear.app', path: '/graphql', method: 'POST',
  headers: { Authorization: process.env.LINEAR_API_KEY, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(getBody) }
}, (res) => {
  let d = ''; res.on('data', c => d += c);
  res.on('end', () => {
    const uuid = JSON.parse(d).data?.issue?.id;
    if (!uuid) { console.error('UUID not found'); return; }
    // Step 2: update state
    const updateBody = JSON.stringify({
      query: `mutation { issueUpdate(id: "${uuid}", input: { stateId: "${process.env.STATE_DONE}" }) { success } }`
    });
    const req2 = https.request({
      hostname: 'api.linear.app', path: '/graphql', method: 'POST',
      headers: { Authorization: process.env.LINEAR_API_KEY, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(updateBody) }
    }, (res2) => {
      let d2 = ''; res2.on('data', c => d2 += c);
      res2.on('end', () => console.log(JSON.parse(d2).data?.issueUpdate?.success ? 'Moved to Done' : 'Failed'));
    });
    req2.write(updateBody); req2.end();
  });
});
req.write(getBody); req.end();
EOF
```

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
WOR-69   | claude-home    | Moved to Done, cleaned up
WOR-XX   | ...            | Skipped (PR not merged)
```

---

## Running against specific branches

If you want to target only specific branches (e.g. from the ticket's AC list), set them explicitly:

```bash
BRANCHES=(
  "feat/WOR-44-linear-template-skill"
  "feat/WOR-52-ai-code-review-should-respect-the-board"
  "feat/WOR-53-interactive-resume-command"
  "feat/WOR-61-generalize-claude-home"
  "feat/WOR-67-prepare-a-ppt-about-introducing-symphony"
  "feat/WOR-69-ticket-sweep-comments"
)
```

Then run Steps 3–4 for each branch, looking up the ticket ID from the branch name (the part after `feat/` up to the second `-`).

---

## Notes

- This skill is safe to run multiple times — it skips tickets already in Done state
- Always prefer `--force` when removing worktrees (they contain `.claude-session-id` which is untracked by design)
- If a worktree directory is missing but the git reference still exists, `git worktree prune` cleans it up
- If `$STATE_DONE` is not set in environment, look it up from `$SYMPHONY_ROOT/config/boards/<board>.json`
