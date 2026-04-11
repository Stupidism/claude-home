---
name: rebase-latest-master
description: Rebase the current branch onto latest master and push. Runs automatically as part of the workflow — no confirmation needed.
---

# Rebase onto Latest Master

## Step 1 — Fetch and verify

```bash
git fetch origin master --quiet

# Verify local ref matches remote HEAD
REMOTE_SHA=$(git ls-remote origin refs/heads/master | cut -f1)
LOCAL_SHA=$(git rev-parse origin/master)
if [ "$REMOTE_SHA" != "$LOCAL_SHA" ]; then
  git fetch origin master --force --quiet
fi
```

## Step 2 — Rebase

```bash
git rebase origin/master
```

## Step 3 — If conflicts arise

Resolve conflicts directly in each conflicting file, then continue:

```bash
git add <resolved-file>
git rebase --continue
```

If the same lines conflict across many commits, abort and run `detangle-commits` first, then retry:

```bash
git rebase --abort
# Run detangle-commits, then retry from Step 1
```

If conflicts still cannot be resolved after detangling, abort and stop. Do not force or guess through conflict resolution.

**Never use merge — the repo requires a linear git history.**

## Step 4 — Push

```bash
git push origin HEAD --force-with-lease
```
