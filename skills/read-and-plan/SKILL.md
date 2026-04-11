---
name: read-and-plan
description: First step for new tickets — read ticket details, identify affected projects, create workpad, move to In Progress. Run once at the start of fresh work.
---

# Read & Plan

## Step 1 — Understand the ticket

Fetch the full ticket details (description, AC, comments) using the appropriate ticket system API.

**If the fetch fails for any reason (missing API key, network error, unknown ticket ID, etc.):**

- **Stop immediately. Do not proceed.**
- Report the exact error and what you tried.
- Do NOT guess requirements from the ticket title, codebase, or any other source.
- Do NOT attempt to use a different ticket system as a fallback.

Once the ticket is successfully fetched:

- Read ticket title, description, and Acceptance Criteria
- Read `AGENTS.md` (repo table of contents)
- Identify affected Nx project(s) from the ticket content

## Step 2 — Load project rules

Check if `<nx-project-path>/WORKFLOW.md` exists for the affected project (e.g. `apps/hiring/WORKFLOW.md`). If it does, read it — those rules supplement the main workflow.

## Step 3 — Figma audit (only when the ticket contains a Figma link)

If no Figma link is present, skip to Step 4.

If a Figma link is present, **run `$SYMPHONY_ROOT/skills/figma-audit/SKILL.md` now, before writing any code.** Paste the resulting per-frame change checklist into the workpad. If the audit triggers a scope mismatch and moves the ticket to Backlog, exit immediately.

## Step 4 — Task size assessment

After the Figma audit (or, if no Figma, after reading the ticket), estimate the implementation surface:

- Count the number of files that need to change or be created.
- Identify any independent sub-features that could ship separately.

**If the task is large** (more than ~15 files to change, or clearly contains multiple independent sub-features), do not implement it as one monolithic unit. Instead:

1. Break it into subtasks. File each subtask as a new ticket in the ticket system (Backlog state), linked to the parent.
2. Record the subtask IDs in the workpad.
3. Implement only the first subtask in this session; leave the rest for the poller to pick up.

## Step 5 — Create workpad

Find or create the single persistent **Claude Workpad** comment on the ticket.

- If `$TICKET_SYSTEM` is `linear`: read `$SYMPHONY_ROOT/skills/linear/SKILL.md` for the workpad template and API commands
- If `$TICKET_SYSTEM` is `jira`: use the Jira MCP tool to add a comment

**Rules:**

- Search existing comments for `## Claude Workpad` before creating one
- If found: reuse it — never create a second workpad
- If not found: create exactly one
- The workpad must include the full per-frame change checklist from Step 3c (if Figma was present)

## Step 6 — Move to In Progress

Transition the ticket to **In Progress** using the appropriate ticket system API.
