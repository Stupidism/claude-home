---
name: submit-for-review
description: Post proof of work evidence to the ticket workpad and move the ticket to Human Review. Works against either Linear or Jira via the ticket dispatcher. Run after PR is created, validation passes, and PR feedback sweep is clean.
---

# Submit for Review

## Prerequisites

Before running this skill, ensure:

- PR is created and CI is green
- App-specific proof of work is done (see `<nx-project-path>/WORKFLOW.md`)
- PR feedback sweep is clean (no outstanding actionable comments)

## Step 1 — Paste E2E artifacts (if any)

Read `$SKILLS_ROOT/paste-e2e-artifacts/SKILL.md` and run it now.

This uploads any Playwright screenshots/videos from the worktree to the ticket and appends them to the workpad as proof of work. It is best-effort — if no artifacts exist or uploads fail, continue to Step 2 without blocking.

## Step 2 — Update workpad with evidence

Update the workpad comment on the ticket. Read `$SKILLS_ROOT/ticket/SKILL.md` — the dispatcher will route to the matching sub-skill (`linear` or `jira`) for the update command.

The environment stamp at the top of the workpad (`<host>:<abs-workdir>@<short-sha>`) is an agent-readable signature — do not remove it.

Ensure all checklist items are checked off and the `### Validation` section shows passing results.

## Step 3 — Move to Human Review

Read `$SKILLS_ROOT/ticket/SKILL.md` and pass the symbolic state `Human Review` (or `$STATE_HUMAN_REVIEW`, which holds the system-specific identifier — a UUID on Linear, a status name on Jira) to the dispatcher. The matching sub-skill takes care of the rest internally: Linear consumes the UUID directly, and the Jira sub-skill resolves the numeric transition ID from the board config or `jira_get_transitions` before calling `jira_transition_issue`.
