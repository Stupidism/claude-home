---
name: jira
description: Jira ticket operations — workpad CRUD, state transitions, comment listing. Loaded by the ticket dispatcher when `$TICKET_SYSTEM=jira`. Do not load directly — go through `$SKILLS_ROOT/ticket/SKILL.md`.
---

# Jira Operations

**Prefer `mcp__claude_ai_Atlassian__*` MCP tools when available** — they handle auth and ADF wrapping automatically. Fall back to Atlassian REST v3 only when those tools are absent from the current session.

## Environment

| Var | Source | Purpose |
|---|---|---|
| `$TICKET_ID` | poller | Jira issue key, e.g. `UP-754` |
| `$JIRA_EMAIL`, `$JIRA_API_TOKEN` | `secrets.env` | Auth for REST fallback |
| `$STATE_TODO`, `$STATE_IN_PROGRESS`, `$STATE_HUMAN_REVIEW`, `$STATE_IN_REVIEW`, `$STATE_REWORK`, `$STATE_MERGING`, `$STATE_DONE` | poller | Jira *status names* (not transition IDs) |

The numeric Jira **transition IDs** and `baseUrl` live in `$SYMPHONY_ROOT/config/boards/<board>.json` under `jira.transitions` and `jira.baseUrl`. They are **not** exported as env vars — read them from the board file when needed:

```bash
BOARD_FILE="$SYMPHONY_ROOT/config/boards/$(echo "$TICKET_ID" | cut -d- -f1 | tr A-Z a-z).json"
JIRA_BASE_URL=$(jq -r '.jira.baseUrl' "$BOARD_FILE")
```

---

## Common operations (MCP)

| Intent | MCP tool |
|---|---|
| Get ticket details + comments | `mcp__claude_ai_Atlassian__getJiraIssue` with `issueIdOrKey: $TICKET_ID` (comments are returned in `fields.comment.comments`) |
| Create a comment (workpad) | `mcp__claude_ai_Atlassian__addCommentToJiraIssue` — pass the markdown body as a plain string; the tool wraps it as ADF |
| Update a comment (workpad) | **No MCP tool** — use the REST fallback (`PUT /rest/api/3/issue/{key}/comment/{id}`) |
| Delete a comment | **No MCP tool** — use the REST fallback (`DELETE /rest/api/3/issue/{key}/comment/{id}`) |
| List available transitions | `mcp__claude_ai_Atlassian__getTransitionsForJiraIssue` |
| Transition ticket state | `mcp__claude_ai_Atlassian__transitionJiraIssue` with the transition `id` returned above |
| Create a new ticket | `mcp__claude_ai_Atlassian__createJiraIssue` |

State name → transition mapping: use `getTransitionsForJiraIssue` to list current transitions and pick the one whose `to.name` matches the target status (`In Progress`, `Human Review`, …). The `jira.transitions` block in the board config holds the static IDs if you prefer to skip the lookup.

The first MCP call needs the `cloudId` for the workspace — `mcp__claude_ai_Atlassian__getAccessibleAtlassianResources` returns it.

---

## Workpad

The workpad contract — single persistent `## Claude Workpad` comment, env stamp on top, plan/AC/validation/notes sections — is identical to Linear. **Reuse the template verbatim from `$SKILLS_ROOT/linear/SKILL.md` under `## Workpad`.**

Jira-specific transport notes:

- When posting through `addCommentToJiraIssue`, pass the raw markdown string. The MCP tool wraps it in ADF; renderers in Jira show it as preformatted text. Do not hand-craft ADF.
- When updating via REST, you must send a full ADF document (see below).
- Search for the workpad by scanning `fields.comment.comments[*].body` from `getJiraIssue`. The body comes back as ADF JSON; serialize it to a string and grep for `## Claude Workpad`.

---

## REST fallback (only when MCP tools are unavailable)

Auth header:

```bash
JIRA_AUTH="Basic $(printf '%s:%s' "$JIRA_EMAIL" "$JIRA_API_TOKEN" | base64)"
```

### Get ticket + comments

```bash
curl -s -H "Authorization: $JIRA_AUTH" -H "Accept: application/json" \
  "$JIRA_BASE_URL/rest/api/3/issue/$TICKET_ID?fields=summary,description,status,labels,comment"
```

To search for an existing workpad, jq into `.fields.comment.comments[]` and pick the one whose ADF body contains `## Claude Workpad`.

### Create comment (workpad)

```bash
BODY=$(node -e '
const fs = require("fs");
const text = fs.readFileSync("/dev/stdin", "utf8");
process.stdout.write(JSON.stringify({
  body: {
    type: "doc",
    version: 1,
    content: [{
      type: "codeBlock",
      attrs: { language: "markdown" },
      content: [{ type: "text", text }],
    }],
  },
}));
' < workpad.md)

curl -s -X POST -H "Authorization: $JIRA_AUTH" -H "Content-Type: application/json" \
  -d "$BODY" "$JIRA_BASE_URL/rest/api/3/issue/$TICKET_ID/comment"
```

Wrapping the markdown in a `codeBlock` node sidesteps ADF rich-text conversion — what goes in is what comes out.

### Update comment

```bash
curl -s -X PUT -H "Authorization: $JIRA_AUTH" -H "Content-Type: application/json" \
  -d "$BODY" "$JIRA_BASE_URL/rest/api/3/issue/$TICKET_ID/comment/$COMMENT_ID"
```

### Delete comment

```bash
curl -s -X DELETE -H "Authorization: $JIRA_AUTH" \
  "$JIRA_BASE_URL/rest/api/3/issue/$TICKET_ID/comment/$COMMENT_ID"
```

### Transition ticket

Resolve the transition ID (prefer the static map in the board config):

```bash
TRANSITION_ID=$(jq -r ".jira.transitions.inProgress" "$BOARD_FILE")
# Or list available transitions dynamically:
# curl -s -H "Authorization: $JIRA_AUTH" "$JIRA_BASE_URL/rest/api/3/issue/$TICKET_ID/transitions"

curl -s -X POST -H "Authorization: $JIRA_AUTH" -H "Content-Type: application/json" \
  -d "{\"transition\":{\"id\":\"$TRANSITION_ID\"}}" \
  "$JIRA_BASE_URL/rest/api/3/issue/$TICKET_ID/transitions"
```

REST v2 (`/rest/api/2/...`) also works and accepts plain-string bodies — that is what `symphony/scripts/ticket-systems/jira.mts` uses. Either version is acceptable for fallback; v3 is the current documented API.
