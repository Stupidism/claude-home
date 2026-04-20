---
name: linear
description: All Linear API operations for Linear tickets — state transitions, workpad comment create/update/read, and the ticket format reference. Read this whenever you need to interact with Linear.
---

# Linear Operations

**Prefer `mcp__linear-server__*` MCP tools for all Linear operations.** They are far more token-efficient than curl+GraphQL and handle escaping automatically. Use curl only as a fallback when the Linear MCP tools are not available in the current session.

`$LINEAR_API_KEY` and `$TICKET_ID` are set in the Symphony environment.

---

## Common operations (MCP)

Pick the matching MCP tool — names may vary slightly per MCP version; match by intent:

| Intent | MCP tool (typical) |
|---|---|
| Get ticket details | `mcp__linear-server__get_issue` with `id: $TICKET_ID` |
| List comments on a ticket | `mcp__linear-server__list_comments` |
| Create a comment (workpad) | `mcp__linear-server__create_comment` |
| Update a comment (workpad) | `mcp__linear-server__update_comment` |
| Change ticket state | `mcp__linear-server__update_issue` with `state: "In Progress" \| "Human Review" \| "Merging" \| "Done"` |
| Create a new ticket (sub-task) | `mcp__linear-server__create_issue` |
| Link child to parent | `mcp__linear-server__update_issue` with `parentId` |

State names (string form) are stable; you do not need to resolve UUIDs when the MCP tool accepts a name.

---

## Workpad

A **single persistent comment** on the Linear ticket — the source of truth for progress, evidence, and notes.

**Rules:**
- Search existing comments for `## Claude Workpad` before creating one.
- If found: reuse it — never create a second workpad.
- All progress updates go in the workpad only (never separate "done" / "summary" comments).
- Do not repeat issue ID or branch name inside the workpad (those live in Linear fields).

**Template:**

````md
## Claude Workpad — $TICKET_ID

```text
<hostname>:<abs-worktree-path>@<short-sha>
```

### Plan

- [ ] 1. Parent task
  - [ ] 1.1 Child task

### Acceptance Criteria

- [ ] AC 1: <exact wording from ticket>

### Validation

- [ ] lint & unit tests: `nx affected --target=lint,test --base=origin/master`
- [ ] App-specific proof of work (see `<nx-project-path>/WORKFLOW.md`)
- [ ] CI checks green

### Notes

- <short progress note>

### Confusions

- <only when execution was unclear>
````

The env stamp code fence at the top is required. Include `### Confusions` only when something was actually confusing.

---

## Curl fallback (only when MCP is unavailable)

Get the ticket's internal UUID, then mutate. State UUIDs are exposed via envvars `$STATE_IN_PROGRESS`, `$STATE_HUMAN_REVIEW`, `$STATE_MERGING`, `$STATE_DONE`.

```bash
TICKET_UUID=$(curl -s -X POST https://api.linear.app/graphql \
  -H "Authorization: $LINEAR_API_KEY" -H "Content-Type: application/json" \
  -d "{\"query\": \"{ issue(id: \\\"${TICKET_ID}\\\") { id } }\"}" \
  | node -e "process.stdout.write(JSON.parse(require('fs').readFileSync('/dev/stdin','utf8')).data.issue.id)")

# Change state
curl -s -X POST https://api.linear.app/graphql \
  -H "Authorization: $LINEAR_API_KEY" -H "Content-Type: application/json" \
  -d "{\"query\": \"mutation { issueUpdate(id: \\\"${TICKET_UUID}\\\", input: { stateId: \\\"${STATE_IN_PROGRESS}\\\" }) { success } }\"}"
```

For comment bodies with newlines/quotes, pass the body as a GraphQL variable (JSON-stringify via `node -e`) rather than inlining into the query string. Reads use `issue(id) { comments { nodes { id body createdAt } } }`; creates use `commentCreate(input: { issueId, body })`; updates use `commentUpdate(id, input: { body })`.

For ticket creation: resolve the team's Backlog state via `workflowStates(filter: { team: { id: { eq: $TEAM_ID } }, name: { eq: "Backlog" } })`, then `issueCreate(input: { teamId, stateId, title, description, priority })`. Link to parent with `issueUpdate(input: { parentId })`.

---

## Ticket format (for humans writing tickets)

```markdown
## Context

<why this work is needed>

## Requirements

- [ ] Requirement 1
- [ ] Requirement 2

## Acceptance Criteria

- [ ] AC 1: <specific, testable condition>

## Figma

<design link — required for UI tickets>

## Scope

App/Service: <hris | payroll | hiring | payroll-backend | ...>
```
