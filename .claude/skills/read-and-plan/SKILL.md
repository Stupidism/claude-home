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

## Step 2 — Format check

Evaluate whether the ticket provides enough information to start implementation.

**Evaluation order:**

1. Check the **Requirements** and **Acceptance Criteria** sections for real, specific content (not template placeholders like `<specific, testable condition>`, `Requirement 1`, etc.).
2. If those sections contain only placeholder text, try to **derive** the requirements and acceptance criteria from the **title** and **Context** section. A ticket with a clear title and a concrete Context paragraph can be actionable even without filled-in Requirements/AC sections.
3. If — after considering the title and Context — the implementation goal is still ambiguous or untestable, **kick the ticket back to Backlog**:
   a. Post a comment on the ticket (using the appropriate ticket system API) that explains specifically what information is missing and what is needed to proceed.
   b. Transition the ticket to `Backlog` state.
   c. **Stop. Do not proceed with the remaining steps.**

**What counts as "clear enough":**

- The intended behavior or change is unambiguous.
- There is at least one testable outcome that can be verified after implementation.
- The scope (which app / service / workflow) can be determined.

**What does NOT automatically mean "kick back":**

- The Requirements/AC sections use the template format — if the title + Context make the intent clear, that is sufficient.
- Minor ambiguities that can be resolved by reading the codebase.

## Step 3 — Identify affected repos

Read the board config at `$SYMPHONY_ROOT/config/boards/<board>.json` (the file matching `$TICKET_ID`'s prefix, e.g. `up.json` for UP-*, `wor.json` for WOR-*). Resolve which `projects[]` entry the ticket belongs to:

- **Jira tickets** (`ticketSystem: "jira"`): the Jira *project key* (e.g. `UP`) is the **team**, not a Symphony project. To pick a Symphony project entry, read the issue's `labels[]` and find the first label of the form `project:<name>`. Match that full label (e.g. `project:symphony`) against `projects[].linearProjectId`. If no `project:*` label is present, the ticket has no project — fall back to `board.defaultRepo`. **Do not match by Jira project key.**
- **Linear tickets** (`ticketSystem: "linear"`): match the ticket's Linear project UUID against `projects[].linearProjectId`.

Once a project entry is matched (or you've fallen back to `defaultRepo`):

1. Read the **`repos[]` array** on the matched project — each entry has a `hint` that explains when that repo is relevant to a ticket.
2. Based on the ticket content and each repo's `hint`, decide which repos are in scope.
3. For each in-scope repo, also read its top-level `description` from the board's `repos[]` array to understand the tech stack and boundaries.
4. For multi-repo tickets, note which is `primaryRepo` (where the branch lives) and which are secondary.

**If the ticket's project is not in the config** (e.g. `$PROJECT_PATH` is the repo root, or no `project:*` label matched), treat the current repo as the only affected repo.

### Step 3a — Worktree-repo sanity check

The poller picks a worktree directory based on its own repo resolution. If that resolution is wrong (e.g. the poller fell back to `defaultRepo` because the `project:*` label wasn't yet mapped in the board config), the current worktree sits inside the wrong repo and any edits you make will land on the wrong codebase.

Compare:

- **Expected repo:** the `primaryRepo` from Step 3 (or `defaultRepo` if no project matched). Look up its `worktreesDir` in `board.repos[]`.
- **Actual worktree:** the current working directory (`$PWD` / `$WORKTREE_PATH`).

If `$PWD` is not inside the expected repo's `worktreesDir`, **stop immediately** and surface this as a **setup error**:

- Post a comment on the ticket explaining: the resolved repo, the expected `worktreesDir`, the actual worktree path, and that the poller needs to recreate the worktree in the correct repo.
- Do **not** transition the ticket to Backlog — this is not a missing-requirements problem.
- Do **not** edit any files. Exit the session.

## Step 4 — Load project rules

For each in-scope repo, check if a `WORKFLOW.md` exists at the project entry path (e.g. `apps/hiring/WORKFLOW.md` in the monorepo, or the root of a standalone repo). If it does, read it — those rules supplement the main workflow.

## Step 5 — Figma audit (only when the ticket contains a Figma link)

If no Figma link is present, skip to Step 6.

If a Figma link is present, **run `$SKILLS_ROOT/figma-audit/SKILL.md` now, before writing any code.** Paste the resulting per-frame change checklist into the workpad. If the audit triggers a scope mismatch and moves the ticket to Backlog, exit immediately.

## Step 6 — Task size assessment

After the Figma audit (or, if no Figma, after reading the ticket), estimate the implementation surface:

- Count the number of files that need to change or be created, across all in-scope repos.
- Identify any independent sub-features that could ship separately.
- Identify any sub-tasks that belong to a different repo and can be split off independently.

**If the task is large** (more than ~15 files to change, or clearly contains multiple independent sub-features or cross-repo sub-tasks), do not implement it as one monolithic unit. Instead:

1. Break it into subtasks. File each subtask as a new ticket in the ticket system (Backlog state), linked to the parent. Specify the target repo in the ticket description.
2. Record the subtask IDs in the workpad.
3. Implement only the first subtask in this session; leave the rest for the poller to pick up.

## Step 7 — Create workpad

Find or create the single persistent **Claude Workpad** comment on the ticket.

- Read `$SKILLS_ROOT/linear/SKILL.md` for the workpad template and API commands

**Rules:**

- Search existing comments for `## Claude Workpad` before creating one
- If found: reuse it — never create a second workpad
- If not found: create exactly one
- The workpad must include the full per-frame change checklist from Step 5 (if Figma was present)
- The workpad must list all in-scope repos and which sub-tasks belong to each

## Step 8 — Move to In Progress

Transition the ticket to **In Progress** using the appropriate ticket system API.
