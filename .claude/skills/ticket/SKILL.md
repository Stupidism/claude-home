---
name: ticket
description: Dispatcher for ticket-system operations. Routes to the right sub-skill (linear / jira / github-projects) based on `$TICKET_SYSTEM`. Read this whenever a workflow step needs to interact with the ticket system — workpad CRUD, state transitions, comment reads, or sub-task creation.
---

# Ticket System Dispatcher

Symphony supports multiple ticket systems. Skills must go through this dispatcher rather than hard-coding a backend, so the same workflow runs against Linear (`WOR-*`), Jira (`UP-*`), or GitHub Projects (e.g. `SY-*`).

## Routing

Inspect `$TICKET_SYSTEM` (exported by the poller — see `symphony/scripts/poll-tickets.mts`):

| `$TICKET_SYSTEM` | Sub-skill to read |
|---|---|
| `linear` (default) | `$SKILLS_ROOT/linear/SKILL.md` |
| `jira` | `$SKILLS_ROOT/jira/SKILL.md` |
| `github-projects` | `$SKILLS_ROOT/github-projects/SKILL.md` |

If `$TICKET_SYSTEM` is unset, treat it as `linear`. If it is any other value, **stop and report the misconfiguration** — do not silently guess.

## Shared contract

Both sub-skills expose the same intents with the same workpad template. The dispatcher does not implement them — it tells you which sub-skill to load and what the contract looks like.

| Intent | Notes |
|---|---|
| Get ticket details | Title, description, state, labels, comments |
| List comments | Returns `{id, body, createdAt, author}` |
| Find existing workpad | Search the comment list for `## Claude Workpad` |
| Create comment (workpad) | One per ticket; never create a second |
| Update comment (workpad) | Mutate by comment id; preserves the env-stamp signature |
| Delete comment | Used by `rework` to wipe the old workpad |
| Change ticket state | Symbolic state name (`Backlog` / `Todo` / `In Progress` / `Human Review` / `In Review` / `Rework` / `Merging` / `Done`) → system-specific ID or transition |
| Create a new ticket (sub-task) | Used by `read-and-plan` when splitting large work; link to parent when supported |

The **workpad template** is defined once in `$SKILLS_ROOT/linear/SKILL.md` under `## Workpad`. The Jira and GitHub Projects sub-skills reuse the same template verbatim — only the transport differs.

## When to read which sub-skill

- Skills that touch a ticket (`read-and-plan`, `submit-for-review`, `rework`, `resume/feedback.md`, …) point you here.
- After loading the matching sub-skill, follow its MCP-first / curl-fallback ordering.
