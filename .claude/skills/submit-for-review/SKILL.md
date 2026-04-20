---
name: submit-for-review
description: Post proof of work evidence to the Linear workpad and move the ticket to Human Review. Run after PR is created, validation passes, and PR feedback sweep is clean.
---

# Submit for Review

## Prerequisites

Before running this skill, ensure:

- PR is created and CI is green
- App-specific proof of work is done (see `<nx-project-path>/WORKFLOW.md`)
- PR feedback sweep is clean (no outstanding actionable comments)

## Step 1 — Paste E2E artifacts (if any)

Read `$SKILLS_ROOT/paste-e2e-artifacts/SKILL.md` and run it now.

This uploads any Playwright screenshots/videos from the worktree to Linear and appends them to the workpad as proof of work. It is best-effort — if no artifacts exist or uploads fail, continue to Step 2 without blocking.

## Step 2 — Update workpad with evidence

Update the workpad comment on Linear (see `$SKILLS_ROOT/linear/SKILL.md` for the update command).

The environment stamp at the top of the workpad (`<host>:<abs-workdir>@<short-sha>`) is an agent-readable signature — do not remove it.

Ensure all checklist items are checked off and the `### Validation` section shows passing results.

## Step 3 — Move to Human Review

Read `$SKILLS_ROOT/linear/SKILL.md` for the state transition curl command. Use the **Human Review** state ID:

```bash
STATE_ID="$STATE_HUMAN_REVIEW"
```
