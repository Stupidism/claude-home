---
name: new-ticket
description: Create a new Symphony-trackable ticket on the right board (UP=Jira, WOR=Linear, etc.), with assignee, labels, type, and state pre-filled from board config. Use when the user says "建 ticket", "create a ticket", "新开一个 ticket", "open an issue", or similar — for new work, not for editing existing tickets.
---

# new-ticket

A new ticket only ends up in Symphony's polling queue if it has the right **assignee + state**. Every config also dictates which API (Jira vs Linear) to use. This skill exists because all of those details are easy to forget when typing free-form.

## When to use

- User asks to create a new Symphony-trackable ticket (most common phrasings: "建 ticket", "create a ticket", "open an issue for X", "新开一个 ticket").
- Skip for: editing existing tickets, adding comments, posting workpad updates — those go through the `linear` skill or direct MCP calls.

## Step-by-step

### 1. Decide the board

- If the user names a board (`UP`, `WOR`, …), use it.
- Otherwise infer from the work: anything touching the `symphony` repo → ask. Don't guess silently.

### 2. Read board config

```bash
# Board file lives at ~/symphony/config/boards/<lowercase>.json
cat ~/symphony/config/boards/up.json
cat ~/symphony/config/symphony.json   # for global assigneeId fallback
```

Pull these fields:

| Field | Source | Used for |
|---|---|---|
| `ticketSystem` | `boards/<x>.json` | `"jira"` → Jira MCP; `"linear"` → Linear MCP |
| `ticketPrefix` | `boards/<x>.json` | Jira `project_key` (uppercase) |
| `teamId` | `boards/<x>.json` (Linear) | Linear `teamId` |
| `assigneeId` | `boards/<x>.json` → fallback `symphony.json` | who to assign to so the poller actually picks it up |
| `states.todo` | `boards/<x>.json` (Linear UUID) / `"To Do"` (Jira name) | initial state |

### 3. Create the ticket

**Jira (UP):**

```text
mcp__mcp-atlassian__jira_create_issue
  project_key       = ticketPrefix (uppercase)
  summary           = <user-provided title>
  issue_type        = "Task"   # or "Bug" if user explicitly says it's a bug
  description       = <markdown body — Jira MCP converts to wiki syntax>
  additional_fields = { "labels": ["project:symphony"] }   # only if this is symphony work
```

**Linear (WOR):**

```text
mcp__linear-server__create_issue
  team       = teamId (or team name "Workstream")
  title      = <user-provided title>
  description= <markdown body>
  assignee   = assigneeId
  state      = "Todo"
  labels     = ["project:symphony"]   # only if this is symphony work
```

### 4. ⚠️ Always verify and re-assign

**This is the most-forgotten step.** Jira's `jira_create_issue` silently drops the `assignee` field — the ticket comes back as `Unassigned`. Linear's `create_issue` honors `assignee` but typos in the UUID also silently fail.

Always do this immediately after creation:

```text
# Jira: re-assign by email. The Jira Cloud API technically accepts accountId,
# but the mcp-atlassian wrapper returns "Issue updated successfully" yet leaves
# the issue Unassigned for both raw accountIds and the "accountid:<id>" prefix
# form — verified empirically on 2026-05-13. Email is the only format that has
# ever produced a non-empty `assignee` on read-back. Do NOT "fix" this back to
# accountId without re-verifying via jira_get_issue.
mcp__mcp-atlassian__jira_update_issue
  issue_key = "<NEW_KEY>"
  fields    = { "assignee": "<user-email>" }

mcp__mcp-atlassian__jira_get_issue
  issue_key = "<NEW_KEY>"
  fields    = "summary,status,assignee,labels"

# Linear: included in create_issue, but read back to confirm.
mcp__linear-server__get_issue id=<NEW_KEY>
```

Then look at the read-back response and confirm:

- `assignee.display_name` is NOT `"Unassigned"`
- `status.name` (Jira) / `state.name` (Linear) matches what you set
- `labels` includes `project:symphony` (for symphony tickets)

If any of those fail, fix before reporting success to the user.

### 5. Report to user

One-liner with the URL and the next action. For UP: `https://workstreamhq.atlassian.net/browse/<KEY>`. For WOR: `https://linear.app/workstream/issue/<KEY>`.

If the poller is currently down (the user mentioned a crash, or it was the reason the ticket exists), remind them to restart it — the poller has to be running for Symphony to pick the ticket up.

## Description template

Use the matching block from `~/symphony/config/linear-templates.json` (`Feature` / `Bug` / `Chore`). Don't include the `## Figma` section unless the work is UI; don't include `## Environment` unless it's a Bug.

For Jira, write in plain markdown — the MCP converts to wiki syntax automatically (`{code}`, `h2.`, `*bold*`, etc.). Avoid backticks for inline `<id>` placeholders because Jira renders `[id]` instead — just say `the id` in prose.

## Common pitfalls (the why behind the verify step)

- **Jira `assignee` dropped on create** — confirmed empirically; must follow up with `jira_update_issue` using **email**, then `jira_get_issue` to verify. AccountId formats look like they succeed but leave the issue Unassigned (see Step 4).
- **Wrong state name** — Jira UP uses `"To Do"` (with space), not `"Todo"`. Linear uses `"Todo"`. Read the config; don't assume.
- **Missing `project:symphony` label** — without it, dashboards filtering by label won't see the ticket. Always add for symphony work.
- **Wrong assigneeId for the board** — `symphony.json` has a Linear UUID; `boards/up.json` has a Jira accountId. Don't cross them. (And even on Jira, accountId only goes into the *config*, not into the assign API call — see above.)
