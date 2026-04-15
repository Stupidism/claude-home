---
name: detangle-commits
description: Rewrite messy local commit history by soft-resetting all commits vs master and re-committing them by logical file groupings. Call this when rebase conflicts span multiple commits on the same files, or before committing when there are more than 15 local commits.
---

# Detangle Commits

Use this when local commit history is entangled (multiple commits touching the same files, making conflict resolution hard) or when there are too many micro-commits.

## When to call this

- Rebase fails with conflicts across **more than 1 commit** touching the same files/lines — abort the rebase, detangle, then rebase again
- Before adding a new commit when there are already **> 15 local commits** compared to `origin/master`

## Steps

### 1. Abort any in-progress rebase

```bash
git rebase --abort 2>/dev/null || true
```

### 2. Soft-reset all local commits to master

```bash
BASE=$(git merge-base HEAD origin/master)
git reset --soft "$BASE"
```

All changes are now staged. Nothing is lost.

### 3. Review what's staged

```bash
git diff --cached --stat
```

### 4. Re-commit by logical grouping

Group related files into atomic commits. Each commit should be independently understandable:

```bash
# Example: commit test files separately from implementation
git add src/feature.ts src/feature.spec.ts
git commit -m "feat(scope): implement X [$TICKET_ID]"

git add src/other-change.ts
git commit -m "fix(scope): fix Y [$TICKET_ID]"
```

**Rules:**

- Follow conventional commits format: `type(scope): description [$TICKET_ID]`
- One logical change per commit — don't bundle unrelated changes
- Tests for a feature go in the same commit as the feature code
- Config / dependency changes get their own commit

### 5. Rebase onto latest master

After detangling, read `$SKILLS_ROOT/rebase-latest-master/SKILL.md` and follow Step 1–2 to rebase cleanly.
