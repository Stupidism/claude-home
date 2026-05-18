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
| `assigneeEmail` | `boards/<x>.json` (Jira only) | the **email** to pass to `jira_update_issue` — see Step 4 |
| `states.backlog` | `boards/<x>.json` (Linear UUID) / `"Backlog"` (Jira name) | initial state — see Step 3 for why |
| `transitions.backlog` | `boards/<x>.json` (Jira only) | transition ID to apply on creation (Jira defaults new issues to "To Do") |

### 3. Create the ticket

**Default state: Backlog**, NOT Todo. The user wants to review new tickets before letting the poller pick them up. Todo tickets get claimed by the poller within one poll cycle (30s), which leaves no room to revise the description, attach context, or hold the ticket back. Backlog is poller-invisible — the user manually moves it to Todo when ready. Only override to Todo when the user explicitly says "建好后直接开跑" / "let the poller take it" / similar.

**Jira (UP):**

Jira always creates new issues in "To Do" regardless of what you ask for, so you MUST also pass a `transition` to move it to Backlog in the same call.

```text
mcp__claude_ai_Atlassian__createJiraIssue
  cloudId              = <from getAccessibleAtlassianResources>
  projectKey           = ticketPrefix (uppercase)
  summary              = <user-provided title>
  issueTypeName        = "Task"   # or "Bug" if user explicitly says it's a bug
  description          = <markdown body>
  contentFormat        = "markdown"
  assignee_account_id  = <assigneeId from board config>
  transition           = { "id": "<transitions.backlog from board config>" }   # e.g. "101" for UP
  additional_fields    = { "labels": ["project:symphony"] }   # only if this is symphony work
```

**Linear (WOR):**

```text
mcp__linear-server__create_issue
  team       = teamId (or team name "Workstream")
  title      = <user-provided title>
  description= <markdown body>
  assignee   = assigneeId
  state      = "Backlog"
  labels     = ["project:symphony"]   # only if this is symphony work
```

### 4. ⚠️ Always verify and re-assign

**This is the most-forgotten step.** Jira's `jira_create_issue` silently drops the `assignee` field — the ticket comes back as `Unassigned`. Linear's `create_issue` honors `assignee` but typos in the UUID also silently fail.

Always do this immediately after creation:

```text
# Jira: re-assign by email read from board config's `assigneeEmail` field.
# The Jira Cloud API technically accepts accountId, but the mcp-atlassian
# wrapper returns "Issue updated successfully" yet leaves the issue Unassigned
# for both raw accountIds and the "accountid:<id>" prefix form — verified
# empirically on 2026-05-13. Email is the only format that has ever produced
# a non-empty `assignee` on read-back. Do NOT "fix" this back to accountId
# without re-verifying via jira_get_issue.
#
# If `assigneeEmail` is missing from board config, stop and ask the user to
# add it — do NOT fall back to conversation-context email (CLAUDE.md
# userEmail), since that is per-machine and not a reliable source of truth.
mcp__mcp-atlassian__jira_update_issue
  issue_key = "<NEW_KEY>"
  fields    = { "assignee": "<assigneeEmail from board config>" }

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
- **Jira default state is "To Do", not Backlog** — `createJiraIssue` always lands in "To Do" first, regardless of what you pass. To start in Backlog (the desired default), pass `transition: { id: "<transitions.backlog>" }` in the create call itself. Don't try to fix via `editJiraIssue` after — Jira uses workflow transitions, not direct status edits. Verify via `getJiraIssue` that `status.name == "Backlog"` before reporting success.
- **Missing `project:symphony` label** — without it, dashboards filtering by label won't see the ticket. Always add for symphony work.
- **Wrong assigneeId for the board** — `symphony.json` has a Linear UUID; `boards/up.json` has a Jira accountId. Don't cross them. (And even on Jira, accountId only goes into the *config*, not into the assign API call — see above.)
