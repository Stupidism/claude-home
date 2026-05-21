---
name: new-ticket
description: Create a new Symphony-trackable ticket on the right board (SY=GitHub Projects, UP=Jira, WOR=Linear read-only), with assignee, labels, type, and state pre-filled from board config. Use when the user says "建 ticket", "create a ticket", "新开一个 ticket", "open an issue", or similar — for new work, not for editing existing tickets.
---

# new-ticket

A new ticket only ends up in Symphony's polling queue if it has the right **assignee + state**. Every config also dictates which API (Jira vs Linear) to use. This skill exists because all of those details are easy to forget when typing free-form.

## When to use

- User asks to create a new Symphony-trackable ticket (most common phrasings: "建 ticket", "create a ticket", "open an issue for X", "新开一个 ticket").
- Skip for: editing existing tickets, adding comments, posting workpad updates — those go through the `linear` skill or direct MCP calls.

## Step-by-step

### 1. Decide the board

- If the user names a board (`UP`, `SY`, `WOR`, …), use it.
- Otherwise infer from the work:
  - **Symphony / `claude-home` automation work → `SY` (github-projects).** This is the default board for new Symphony tickets as of the UP-795 cutover. Do **not** create new tickets on `WOR` for Symphony work — WOR is now read-only history (see `symphony/scripts/list-open-wor-tickets.mts` for the in-flight WOR backlog).
  - Anything else (product work, monorepo features, bugs) → ask. Don't guess silently.

### 2. Read board config

```bash
# Board file lives at ~/symphony/config/boards/<lowercase>.json
cat ~/symphony/config/boards/sy.json   # default for Symphony work (github-projects)
cat ~/symphony/config/boards/up.json   # product tickets (Jira)
cat ~/symphony/config/symphony.json    # for global assigneeId fallback
```

Pull these fields:

| Field | Source | Used for |
|---|---|---|
| `ticketSystem` | `boards/<x>.json` | `"jira"` → Jira MCP; `"linear"` → Linear MCP; `"github-projects"` → GitHub MCP + ProjectV2 GraphQL |
| `ticketPrefix` | `boards/<x>.json` | Jira `project_key` (uppercase); github-projects: shown in identifier (`SY-42`) |
| `teamId` | `boards/<x>.json` (Linear) | Linear `teamId` |
| `assigneeId` | `boards/<x>.json` → fallback `symphony.json` | who to assign to so the poller actually picks it up. Format varies by backend: Linear UUID, Jira accountId, or GitHub username/login |
| `assigneeEmail` | `boards/<x>.json` (Jira only) | the **email** to pass to `jira_update_issue` — see Step 4 |
| `githubProjects.owner`, `githubProjects.projectNumber`, `githubProjects.repo`, `githubProjects.statusField` | `boards/<x>.json` (github-projects only) | project coordinates + status single-select field |
| `states.backlog` | `boards/<x>.json` (Linear UUID) / `"Backlog"` (Jira name) / option name (github-projects, e.g. `"Backlog"`) | initial state — see Step 3 for why |
| `transitions.backlog` | `boards/<x>.json` (Jira only) | transition ID to apply immediately after creation (Jira defaults new issues to "To Do") |

### 3. Create the ticket

**Default state: Backlog**, NOT Todo. The user wants to review new tickets before letting the poller pick them up. Todo tickets get claimed by the poller within one poll cycle (30s), which leaves no room to revise the description, attach context, or hold the ticket back. Backlog is poller-invisible — the user manually moves it to Todo when ready. Only override to Todo when the user explicitly says "建好后直接开跑" / "let the poller take it" / similar.

**Jira (UP):**

Jira always creates new issues in "To Do" regardless of what you ask for, and `jira_create_issue` does not accept a transition. Create the issue unassigned, then immediately call `jira_transition_issue` with the board config's Backlog transition before assigning it.

**Do not assign the ticket during the create call.** Even when `createJiraIssue` accepts `assignee_account_id`, Jira can briefly expose the issue as assigned to you before the Backlog transition finishes. That is enough for the poller to grab it on the next cycle. Create it unassigned, land it in Backlog first, verify that state, and only then assign it to yourself.

```text
mcp__mcp-atlassian__jira_create_issue
  project_key       = ticketPrefix (uppercase)
  summary           = <user-provided title>
  issue_type        = "Task"   # or "Bug" if user explicitly says it's a bug
  description       = <markdown body>
  assignee          = null
  additional_fields = { "labels": ["project:symphony"] }   # only if this is symphony work

mcp__mcp-atlassian__jira_transition_issue
  issue_key      = "<NEW_KEY>"
  transition_id  = "<transitions.backlog from board config>"   # e.g. "101" for UP
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

**GitHub Projects (SY etc.):**

GitHub Issues don't carry the Symphony state on themselves — state lives in a `Status` single-select field on the ProjectV2 the issue is added to. Creating the issue is a three-step sequence: create the issue (unassigned), add it to the project, then set the `Status` field to `Backlog`. Only assign once Status=Backlog has been verified — same hazard as Jira: an assigned ticket in the wrong column gets claimed by the poller before you can roll it back.

```text
# 1. Create the issue, unassigned. Use mcp__github__issue_write so labels
#    and body go through one call; do not pass `assignees` yet.
mcp__github__issue_write
  method = "create"
  owner  = "<githubProjects.owner>"
  repo   = "<repo name only — split githubProjects.repo on '/' and take the second segment>"
  title  = <user-provided title>
  body   = <markdown body>
  labels = ["project:symphony"]   # only if this is symphony work
# → response includes node_id (issue's GraphQL ID) and number.

# 2. Add the new issue to the ProjectV2. There is no MCP tool for this —
#    resolve the project's GraphQL ID and call addProjectV2ItemById.
#    See $SKILLS_ROOT/github-projects/SKILL.md → "State transitions" for the
#    schema lookup query. The mutation:
#
#    mutation($p:ID!,$c:ID!){
#      addProjectV2ItemById(input:{projectId:$p,contentId:$c}){ item{ id } }
#    }
#
#    variables: { p: <projectId>, c: <issue node_id> }
#    → response includes the new projectV2Item.id — the item id you need next.

# 3. Set Status = Backlog on the new project item. Same updateProjectV2ItemFieldValue
#    mutation the adapter uses (see github-projects/SKILL.md). Pull the option id
#    for githubProjects.states.backlog ("Backlog") out of the schema fetch above.
```

Only after Step 3 succeeds — verified by re-reading the item's `Status` field — call `mcp__github__issue_write method=update assignees=[<assigneeId from board config>]` to assign the issue. For github-projects boards, `assigneeId` is the GitHub **username/login** (e.g. `"Stupidism"`), not a numeric ID — the GitHub API rejects numeric IDs for assignment.

### 4. ⚠️ Verify Backlog first, then assign

**This is the most-forgotten step.** Jira creation has two separate hazards: assigning too early can let the poller steal the ticket before it reaches Backlog, and assigning with the wrong field format can leave it `Unassigned`. Linear's `create_issue` honors `assignee` but typos in the UUID also silently fail.

Always do this immediately after creation:

```text
mcp__mcp-atlassian__jira_get_issue
  issue_key = "<NEW_KEY>"
  fields    = "summary,status,assignee,labels"

# Confirm `status.name == "Backlog"` before assigning. If Jira still shows
# "To Do", call jira_transition_issue with `transitions.backlog` and read it
# back again. Do not assign a non-Backlog ticket to yourself, or the poller can
# claim it immediately.
#
# Jira: once Backlog is confirmed, assign by email read from board config's
# `assigneeEmail` field. The Jira Cloud API technically accepts accountId, but
# the mcp-atlassian wrapper returns "Issue updated successfully" yet leaves the
# issue Unassigned for both raw accountIds and the "accountid:<id>" prefix form
# — verified empirically on 2026-05-13. Email is the only format that has ever
# produced a non-empty `assignee` on read-back. Do NOT "fix" this back to
# accountId without re-verifying via jira_get_issue.
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

# GitHub Projects: re-read the issue and the ProjectV2 item's Status field.
# Use mcp__github__issue_read method=get to confirm assignees, then re-run the
# ProjectV2 items query (see $SKILLS_ROOT/github-projects/SKILL.md) to confirm
# Status == "Backlog" on the item.
```

Then look at the read-back response and confirm:

- `status.name` (Jira) / `state.name` (Linear) matches what you set
- `assignee.display_name` is NOT `"Unassigned"`
- `labels` includes `project:symphony` (for symphony tickets)

If any of those fail, fix before reporting success to the user.

### 5. Report to user

One-liner with the URL and the next action. For UP: `https://workstreamhq.atlassian.net/browse/<KEY>`. For WOR: `https://linear.app/workstream/issue/<KEY>`. For github-projects boards: the issue's HTML URL (from the create response, of the form `https://github.com/<owner>/<repo>/issues/<number>`).

If the poller is currently down (the user mentioned a crash, or it was the reason the ticket exists), remind them to restart it — the poller has to be running for Symphony to pick the ticket up.

## Description template

Use the matching block from `~/symphony/config/linear-templates.json` (`Feature` / `Bug` / `Chore`). Don't include the `## Figma` section unless the work is UI; don't include `## Environment` unless it's a Bug.

For Jira, write in plain markdown — the MCP converts to wiki syntax automatically (`{code}`, `h2.`, `*bold*`, etc.). Avoid backticks for inline `<id>` placeholders because Jira renders `[id]` instead — just say `the id` in prose.

## Common pitfalls (the why behind the verify step)

- **Jira assignment can race the poller** — if the ticket is assigned to you before it is safely in Backlog, the poller can claim it during that gap. Keep the create call unassigned, verify `status.name == "Backlog"`, then assign.
- **Jira assignment by accountId still fails in practice** — once the ticket is in Backlog, re-assign with `jira_update_issue` using **email**, then `jira_get_issue` to verify. AccountId formats look like they succeed but leave the issue Unassigned (see Step 4).
- **Jira default state is "To Do", not Backlog** — `jira_create_issue` always lands in "To Do" first and does not accept a transition argument. To start in Backlog (the desired default), create the issue unassigned, then immediately call `jira_transition_issue` with `transitions.backlog`. Don't try to fix via `editJiraIssue` after — Jira uses workflow transitions, not direct status edits.
- **Missing `project:symphony` label** — without it, dashboards filtering by label won't see the ticket. Always add for symphony work.
- **Wrong assigneeId for the board** — `symphony.json` has a Linear UUID; `boards/up.json` has a Jira accountId. Don't cross them. (And even on Jira, accountId only goes into the *config*, not into the assign API call — see above.)
