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
- Read `AGENTS.md` (repo table of contents) if it exists in the current repo root

## Step 2 — Identify affected repos

Read the board config at `$SYMPHONY_ROOT/config/boards/wor.json` (or the relevant board file). Find the current project in `projects[]` by matching `$TICKET_ID`'s project, then:

1. Read the **`repos[]` array** on the matched project — each entry has a `hint` that explains when that repo is relevant to a ticket.
2. Based on the ticket content and each repo's `hint`, decide which repos are in scope.
3. For each in-scope repo, also read its top-level `description` from the board's `repos[]` array to understand the tech stack and boundaries.
4. For multi-repo tickets, note which is `primaryRepo` (where the branch lives) and which are secondary.

**If the ticket's project is not in the config** (e.g. `$PROJECT_PATH` is the repo root), treat the current repo as the only affected repo.

## Step 3 — Load project rules

For each in-scope repo, check if a `WORKFLOW.md` exists at the project entry path (e.g. `apps/hiring/WORKFLOW.md` in the monorepo, or the root of a standalone repo). If it does, read it — those rules supplement the main workflow.

## Step 4 — Figma audit (only when the ticket contains a Figma link)

If no Figma link is present, skip to Step 5.

If a Figma link is present, **run `$SKILLS_ROOT/figma-audit/SKILL.md` now, before writing any code.** Paste the resulting per-frame change checklist into the workpad. If the audit triggers a scope mismatch and moves the ticket to Backlog, exit immediately.

## Step 5 — Task size assessment

After the Figma audit (or, if no Figma, after reading the ticket), estimate the implementation surface:

- Count the number of files that need to change or be created, across all in-scope repos.
- Identify any independent sub-features that could ship separately.
- Identify any sub-tasks that belong to a different repo and can be split off independently.

**If the task is large** (more than ~15 files to change, or clearly contains multiple independent sub-features or cross-repo sub-tasks), do not implement it as one monolithic unit. Instead:

1. Break it into subtasks. File each subtask as a new ticket in the ticket system (Backlog state), linked to the parent. Specify the target repo in the ticket description.
2. Record the subtask IDs in the workpad.
3. Implement only the first subtask in this session; leave the rest for the poller to pick up.

## Step 6 — Create workpad

Find or create the single persistent **Claude Workpad** comment on the ticket.

- Read `$SKILLS_ROOT/linear/SKILL.md` for the workpad template and API commands

**Rules:**

- Search existing comments for `## Claude Workpad` before creating one
- If found: reuse it — never create a second workpad
- If not found: create exactly one
- The workpad must include the full per-frame change checklist from Step 4 (if Figma was present)
- The workpad must list all in-scope repos and which sub-tasks belong to each

## Step 7 — Move to In Progress

Transition the ticket to **In Progress** using the appropriate ticket system API.
