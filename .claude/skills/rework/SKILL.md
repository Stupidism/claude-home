---
name: rework
description: Full approach reset when a ticket is moved to Rework — close PR, delete workpad, create fresh branch, and start over. Also handles incremental feedback (not full rework).
---

# Rework

## Full Rework (ticket moved to Rework state)

Treat this as a **full approach reset** — not incremental patching:

1. Re-read the full issue body and all Human Review comments; explicitly identify what will be done differently
2. Close the existing PR: `gh pr close <PR_NUMBER>`
3. Remove the existing `## Claude Workpad` comment via the ticket dispatcher (read `$SKILLS_ROOT/ticket/SKILL.md` — it routes to `linear` or `jira` based on `$TICKET_SYSTEM`)
4. Create a fresh branch from `origin/master` (read `$SKILLS_ROOT/setup-worktree/SKILL.md`)
5. Start over from Step 1 (Read & Plan) with a new workpad

## Incremental Feedback (ticket still in Human Review / In Review)

If the ticket has reviewer feedback but was NOT moved to Rework:

1. Address all review comments
2. If code changed, re-run lint, unit tests, and E2E
3. Push update
4. Run the PR Feedback Sweep (read `$SKILLS_ROOT/pr-feedback-sweep/SKILL.md`)
5. Move back to **Human Review** (read `$SKILLS_ROOT/submit-for-review/SKILL.md`)
