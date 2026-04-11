---
name: setup-worktree
description: Create an isolated git worktree for a WOR ticket, symlink node_modules, and install dependencies. Run once when a ticket moves from Todo to In Progress.
---

# Setup Worktree

**Always use a worktree. Never work in the main repo directory.**

## Step 1 — Create the worktree

```bash
TICKET_ID="WOR-XX"
SLUG="short-description"
BRANCH="feat/${TICKET_ID}-${SLUG}"
FOLDER=$(echo "$BRANCH" | tr '/' '--')
WORKTREES_DIR="${WORKTREES_DIR:-../workstream-mono-worktrees}"

git worktree add "$WORKTREES_DIR/$FOLDER" -b "$BRANCH"
cd "$WORKTREES_DIR/$FOLDER"
```

## Step 2 — Reuse node_modules and install

```bash
ln -s "$REPO_ROOT/node_modules" node_modules   # reuse main repo deps — do this before any install
pnpm install                                   # only needed if pnpm-lock.yaml changed
```

## Step 3 — Verify

```bash
pwd          # should be inside the worktree
git branch   # should show the new branch
ls -la node_modules  # should be a symlink
```
