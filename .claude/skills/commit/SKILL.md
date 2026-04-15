---
name: symphony-commit
description: Symphony autonomous version of commit-changes — skips all interactive confirmations
---

# Symphony Commit

Follow all rules in `$SKILLS_ROOT/commit-changes/SKILL.md`, with these overrides:

- **Stage automatically**: run `git add -u` if nothing is staged — do not ask the user
- **Commit directly**: do not show the commit message for confirmation before committing
- **Push automatically**: if the branch has diverged, push with `--force-with-lease` without asking
- **Node version manager**: default to `. ~/.nvm/nvm.sh && nvm use &&` if undetected — do not ask the user

## claude-home Repo

When committing to the claude-home repo (detected when the git remote contains `claude-home` or `$REPO_ROOT` is `~/`):

- **Only stage whitelisted paths** — the home directory contains non-repo files that must never be staged
- Use `git add .claude/ symphony/ README.md` instead of `git add -u`
- Do **not** stage `symphony/config/`, `symphony/secrets.env`, or any runtime data — these are gitignored

## Pre-commit checks

### 1. Detangle check

```bash
git log --oneline origin/master..HEAD | wc -l
```

If > 15 local commits, read `$SKILLS_ROOT/detangle-commits/SKILL.md` and run it first.

### 2. Accidental file check

Before staging, verify you are NOT committing any of these:

- `node_modules/` or `node_modules` symlinks
- `.claude-session-id`
- `.env`, `.env.symphony`, or any file matching `.env.*` (except `.env.*.example`)
- Lock file changes unrelated to your ticket (`pnpm-lock.yaml` when you didn't add deps)

If any are staged, unstage them: `git reset HEAD <file>`

## Conventions

- **Branch naming**: `feat/$TICKET_ID-slug`, `fix/$TICKET_ID-slug`, `chore/$TICKET_ID-slug`
- **Commit format**: `type(scope): description [$TICKET_ID]` — conventional commits
- **One ticket = one PR**: do not bundle unrelated changes
- **PR label**: every PR must have the `symphony` label
- **No merge, ever**: always rebase
