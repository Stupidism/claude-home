---
name: jira
description: Jira ticket operations — workpad CRUD, state transitions, comment listing. Loaded by the ticket dispatcher when `$TICKET_SYSTEM=jira`. Do not load directly — go through `$SKILLS_ROOT/ticket/SKILL.md`.
---

# Jira Operations

**Prefer `mcp__mcp-atlassian__jira_*` MCP tools when available** — they handle auth and ADF wrapping automatically. This is the namespace the rest of the repo uses (see `$SKILLS_ROOT/new-ticket/SKILL.md`); the `mcp__claude_ai_Atlassian__*` connector is a possible alternative but is not the project's default. Fall back to Atlassian REST v3 only when both MCP namespaces are absent from the current session.

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
| Get ticket details + comments | `mcp__mcp-atlassian__jira_get_issue` with `issue_key: $TICKET_ID` (comments come back inline) |
| Create a comment (workpad) | `mcp__mcp-atlassian__jira_add_comment` — pass markdown directly |
| Update a comment (workpad) | **No MCP tool** — use the REST fallback (`PUT /rest/api/3/issue/{key}/comment/{id}`) |
| Delete a comment | **No MCP tool** — use the REST fallback (`DELETE /rest/api/3/issue/{key}/comment/{id}`) |
| List available transitions | `mcp__mcp-atlassian__jira_get_transitions` |
| Transition ticket state | `mcp__mcp-atlassian__jira_transition_issue` with the transition `id` returned above |
| Create a new ticket | `mcp__mcp-atlassian__jira_create_issue` for generic Jira work; for Symphony ticket creation follow `$SKILLS_ROOT/new-ticket/SKILL.md`, which uses `mcp__claude_ai_Atlassian__createJiraIssue` so the issue can reach Backlog before it is assigned |

State name → transition mapping: list current transitions and pick the one whose target status matches the desired Symphony state (`In Progress`, `Human Review`, …). The `jira.transitions` block in the board config holds the static IDs if you prefer to skip the lookup.

If only the alternative `mcp__claude_ai_Atlassian__*` connector is present (no `mcp-atlassian` server), the equivalent tool names are `getJiraIssue` / `addCommentToJiraIssue` / `getTransitionsForJiraIssue` / `transitionJiraIssue` / `createJiraIssue`, and `getAccessibleAtlassianResources` returns the `cloudId` required by those calls.

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
# `base64` wraps at 76 columns by default on GNU coreutils, which would
# embed a newline into the header. `tr -d '\n'` strips wrapping on both
# macOS and GNU.
JIRA_AUTH="Basic $(printf '%s:%s' "$JIRA_EMAIL" "$JIRA_API_TOKEN" | base64 | tr -d '\n')"
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
