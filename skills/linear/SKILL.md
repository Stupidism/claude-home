---
name: linear
description: All Linear API operations for WOR tickets — state transitions, workpad comment create/update/read, and the ticket format reference. Read this whenever you need to interact with Linear.
---

# Linear Operations for WOR Tickets

> ⚠️ **NEVER use `mcp__linear-server__*` tools** — they require interactive OAuth and will always fail in autonomous mode. Use only the curl commands below.

WOR tickets live in **Linear** (not Jira). Use the curl commands below.
`$LINEAR_API_KEY` and `$TICKET_ID` are already set in the Symphony environment.

---

## Ticket State Transitions

### Step 1 — Get the ticket's internal UUID

```bash
TICKET_UUID=$(curl -s -X POST https://api.linear.app/graphql \
  -H "Authorization: $LINEAR_API_KEY" \
  -H "Content-Type: application/json" \
  -d "{\"query\": \"{ issue(id: \\\"${TICKET_ID}\\\") { id } }\"}" \
  | node -e "process.stdout.write(JSON.parse(require('fs').readFileSync('/dev/stdin','utf8')).data.issue.id)")
```

### Step 2 — Update the state

```bash
# → In Progress   (at start of work)
STATE_ID="$STATE_IN_PROGRESS"

# → Human Review  (after PR created and evidence posted)
STATE_ID="$STATE_HUMAN_REVIEW"

# → Merging       (after PR approved)
STATE_ID="$STATE_MERGING"

# → Done          (after squash-merge)
STATE_ID="$STATE_DONE"

curl -s -X POST https://api.linear.app/graphql \
  -H "Authorization: $LINEAR_API_KEY" \
  -H "Content-Type: application/json" \
  -d "{\"query\": \"mutation { issueUpdate(id: \\\"${TICKET_UUID}\\\", input: { stateId: \\\"${STATE_ID}\\\" }) { success } }\"}"
```

---

## Workpad

The workpad is a **single persistent comment** on the Linear ticket. It is the single source of truth for progress, evidence, and notes.

**Rules:**

- Search existing comments for `## Claude Workpad` before creating one
- If found: reuse it — never create a second workpad comment
- If not found: create exactly one
- Never post separate "done" or "summary" comments — all updates go in the workpad only
- Do not include issue ID or branch name in the workpad (those belong in Linear issue fields)

**Template:**

````md
## Claude Workpad — WOR-XX

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

- <short progress note with timestamp>

### Confusions

- <only include when something was confusing during execution>
````

The environment stamp (`<host>:<abs-workdir>@<short-sha>`) must be at the top in a code fence. The `### Confusions` section is required when any part of execution was unclear — omit it only when execution was straightforward.

---

## Post a Linear Comment (create workpad)

Run **after** getting `TICKET_UUID` above.

```bash
# Replace the body text as needed (escape newlines as \n, quotes as \")
COMMENT_BODY="## Claude Workpad — ${TICKET_ID}\n\`\`\`text\n$(hostname):$(pwd)@$(git rev-parse --short HEAD)\n\`\`\`\n\n### Plan\n- [ ] Understand scope\n- [ ] Implement\n- [ ] Lint & unit tests\n- [ ] App-specific proof of work\n- [ ] Create PR\n\n### Acceptance Criteria\n- [ ] AC 1\n\n### Validation\n- [ ] lint & unit tests: nx affected --target=lint,test --base=origin/master\n- [ ] App-specific proof of work\n- [ ] CI checks green\n\n### Notes\n- Started"

curl -s -X POST https://api.linear.app/graphql \
  -H "Authorization: $LINEAR_API_KEY" \
  -H "Content-Type: application/json" \
  -d "{\"query\": \"mutation { commentCreate(input: { issueId: \\\"${TICKET_UUID}\\\", body: \\\"${COMMENT_BODY}\\\" }) { success comment { id } } }\"}"
```

Save the returned `comment.id` — use it for all subsequent workpad updates via `commentUpdate`.

---

## Read Linear Ticket Comments

```bash
curl -s -X POST https://api.linear.app/graphql \
  -H "Authorization: $LINEAR_API_KEY" \
  -H "Content-Type: application/json" \
  -d "{\"query\": \"{ issue(id: \\\"${TICKET_ID}\\\") { comments { nodes { id body createdAt } } } }\"}" \
  | node -e "const d=JSON.parse(require('fs').readFileSync('/dev/stdin','utf8')); d.data.issue.comments.nodes.forEach(c=>console.log(c.createdAt, c.id, c.body))"
```

---

## Update an Existing Comment

```bash
COMMENT_ID="<saved-from-create>"
UPDATED_BODY="## Claude Workpad — ${TICKET_ID}\n..."

curl -s -X POST https://api.linear.app/graphql \
  -H "Authorization: $LINEAR_API_KEY" \
  -H "Content-Type: application/json" \
  -d "{\"query\": \"mutation { commentUpdate(id: \\\"${COMMENT_ID}\\\", input: { body: \\\"${UPDATED_BODY}\\\" }) { success } }\"}"
```

---

## Ticket Format (for PMs / engineers writing tickets)

```markdown
## Context

<why this work is needed>

## Requirements

- [ ] Requirement 1
- [ ] Requirement 2

## Acceptance Criteria

- [ ] AC 1: <specific, testable condition>
- [ ] AC 2: <specific, testable condition>

## Figma

<design link — required for UI tickets>

## Scope

App/Service: <hris | payroll | hiring | payroll-backend | ...>
```
