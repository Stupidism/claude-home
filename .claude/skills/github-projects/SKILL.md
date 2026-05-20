---
name: github-projects
description: GitHub Projects (ProjectV2) ticket operations — workpad CRUD, state transitions, comment listing. Loaded by the ticket dispatcher when `$TICKET_SYSTEM=github-projects`. Do not load directly — go through `$SKILLS_ROOT/ticket/SKILL.md`.
---

# GitHub Projects Operations

**Prefer `mcp__github__*` MCP tools for everything that has one.** They handle auth and pagination automatically. Two operations don't have MCP equivalents (ProjectV2 state mutations, comment update/delete) — fall back to the GitHub GraphQL or REST API for those.

GitHub Projects = ProjectV2. State lives in a single-select field (default `Status`) on a Project that the Issue is added to; comments and labels live on the backing Issue inside its repo.

## Environment

| Var | Source | Purpose |
|---|---|---|
| `$TICKET_ID` | poller | Symphony ticket key, e.g. `SY-42` (`<ticketPrefix>-<issue_number>`) |
| `$GITHUB_TOKEN` | `secrets.env` | Fine-grained PAT — needs Issues:write, Projects:write, Metadata:read on the configured repo + project |

The board config at `$SYMPHONY_ROOT/config/boards/<board>.json` carries the GitHub-side coordinates under `githubProjects.{owner,projectNumber,repo,statusField,states}`. Read it whenever you need the project ID, status field name, or option name for a Symphony state:

```bash
BOARD_FILE="$SYMPHONY_ROOT/config/boards/$(echo "$TICKET_ID" | cut -d- -f1 | tr A-Z a-z).json"
GH_OWNER=$(jq -r '.githubProjects.owner' "$BOARD_FILE")
GH_REPO=$(jq -r '.githubProjects.repo' "$BOARD_FILE")        # "owner/name"
GH_PROJECT_NUMBER=$(jq -r '.githubProjects.projectNumber' "$BOARD_FILE")
GH_STATUS_FIELD=$(jq -r '.githubProjects.statusField // "Status"' "$BOARD_FILE")
GH_STATE_BACKLOG=$(jq -r '.githubProjects.states.backlog' "$BOARD_FILE")
```

`$TICKET_ID` is the synthetic Symphony identifier (e.g. `SY-42`). The matching GitHub issue number is the digits after the prefix:

```bash
ISSUE_NUMBER=$(echo "$TICKET_ID" | awk -F- '{print $2}')
```

The Symphony adapter packs `<projectItemId>|<owner/repo>|<issueNumber>` as the opaque `Issue.id`, but skills only ever deal with the human identifier — they don't need the item ID.

---

## Common operations (MCP)

| Intent | MCP tool | Notes |
|---|---|---|
| Get ticket details | `mcp__github__issue_read` `method=get` | Pass `owner`, `repo`, `issue_number`. Comments come back via a separate `get_comments` call. |
| List comments | `mcp__github__issue_read` `method=get_comments` | Paginate via `page` / `perPage`. |
| Create a comment (workpad) | `mcp__github__add_issue_comment` | Pass `body` as raw Markdown — GitHub renders it directly. |
| Update a comment (workpad) | **No MCP tool** — use REST fallback (`PATCH /repos/{owner}/{repo}/issues/comments/{comment_id}`) |
| Delete a comment | **No MCP tool** — use REST fallback (`DELETE /repos/{owner}/{repo}/issues/comments/{comment_id}`) |
| List labels on a ticket | `mcp__github__issue_read` `method=get_labels` |
| Add / remove labels | `mcp__github__issue_write` `method=update` with `labels` (full replace) |
| Create a new ticket | `mcp__github__issue_write` `method=create`; for Symphony ticket creation follow `$SKILLS_ROOT/new-ticket/SKILL.md`, which creates the issue, adds it to the project, then sets the Status field to Backlog |
| Add a sub-issue (parent link) | `mcp__github__sub_issue_write` `method=add` |
| Change ticket state | **No MCP tool** — ProjectV2 single-select mutations require GraphQL (see below) |

`mcp__github__issue_write method=update` with `labels` replaces the full label set, so when you want to add or remove one specific label, read the current labels via `issue_read method=get_labels` first and pass the merged array. The poller's adapter uses targeted REST endpoints to avoid the round-trip; skills don't need to.

---

## State transitions (GraphQL — required)

ProjectV2 has no MCP equivalent for setting a single-select field. Use the GitHub GraphQL API:

```bash
# Resolve the project ID and the status field's option IDs (cache per session).
GH_TOKEN="$GITHUB_TOKEN"
SCHEMA=$(curl -s -H "Authorization: Bearer $GH_TOKEN" -H "Content-Type: application/json" \
  -X POST https://api.github.com/graphql \
  -d "$(jq -n --arg owner "$GH_OWNER" --argjson num "$GH_PROJECT_NUMBER" '{
    query: "query($owner:String!,$num:Int!){ user(login:$owner){ projectV2(number:$num){ id fields(first:50){ nodes{ ... on ProjectV2SingleSelectField{ id name options{ id name } } } } } } organization(login:$owner){ projectV2(number:$num){ id fields(first:50){ nodes{ ... on ProjectV2SingleSelectField{ id name options{ id name } } } } } } }",
    variables: { owner: $owner, num: $num }
  }')")
```

Then look up the project's `Status` field's `option.id` for the target state name (read from `githubProjects.states.<symphonyState>` in the board config), and the item id for the issue, and:

```bash
curl -s -H "Authorization: Bearer $GH_TOKEN" -H "Content-Type: application/json" \
  -X POST https://api.github.com/graphql \
  -d '{"query":"mutation($p:ID!,$i:ID!,$f:ID!,$o:String!){ updateProjectV2ItemFieldValue(input:{projectId:$p,itemId:$i,fieldId:$f,value:{singleSelectOptionId:$o}}){ projectV2Item{ id } } }","variables":{"p":"<projectId>","i":"<itemId>","f":"<statusFieldId>","o":"<optionId>"}}'
```

The poller already does this via `symphony/scripts/ticket-systems/github-projects.mts` — prefer triggering a transition through Symphony's normal flow rather than calling GraphQL by hand. Only reach for the raw mutation when running the skill outside the poller (e.g. one-off `cleanup-tickets` against a stuck ticket).

---

## Workpad

The workpad contract — single persistent `## Claude Workpad` comment, env stamp on top, plan/AC/validation/notes sections — is identical to Linear. **Reuse the template verbatim from `$SKILLS_ROOT/linear/SKILL.md` under `## Workpad`.**

Transport notes specific to GitHub Issues:

- Comment bodies are plain Markdown — no ADF wrapping. What you POST is what gets rendered.
- Find the existing workpad by listing comments (`issue_read method=get_comments`) and searching for the `## Claude Workpad` heading in `body`.
- The workpad lives on the **backing Issue**, not on the ProjectV2 item — comments only exist on Issues.

---

## REST fallback (only when MCP tools are unavailable)

Auth header:

```bash
GH_AUTH="Authorization: Bearer $GITHUB_TOKEN"
GH_ACCEPT="Accept: application/vnd.github+json"
GH_VERSION="X-GitHub-Api-Version: 2022-11-28"
OWNER=$(echo "$GH_REPO" | cut -d/ -f1)
NAME=$(echo "$GH_REPO" | cut -d/ -f2)
```

### Get issue + comments

```bash
curl -s -H "$GH_AUTH" -H "$GH_ACCEPT" -H "$GH_VERSION" \
  "https://api.github.com/repos/$OWNER/$NAME/issues/$ISSUE_NUMBER"

curl -s -H "$GH_AUTH" -H "$GH_ACCEPT" -H "$GH_VERSION" \
  "https://api.github.com/repos/$OWNER/$NAME/issues/$ISSUE_NUMBER/comments?per_page=100"
```

### Create / update / delete comments

```bash
# Create
curl -s -X POST -H "$GH_AUTH" -H "$GH_ACCEPT" -H "$GH_VERSION" \
  -d "$(jq -n --arg body "$WORKPAD" '{body:$body}')" \
  "https://api.github.com/repos/$OWNER/$NAME/issues/$ISSUE_NUMBER/comments"

# Update
curl -s -X PATCH -H "$GH_AUTH" -H "$GH_ACCEPT" -H "$GH_VERSION" \
  -d "$(jq -n --arg body "$WORKPAD" '{body:$body}')" \
  "https://api.github.com/repos/$OWNER/$NAME/issues/comments/$COMMENT_ID"

# Delete
curl -s -X DELETE -H "$GH_AUTH" -H "$GH_ACCEPT" -H "$GH_VERSION" \
  "https://api.github.com/repos/$OWNER/$NAME/issues/comments/$COMMENT_ID"
```

### Add / remove labels

```bash
curl -s -X POST -H "$GH_AUTH" -H "$GH_ACCEPT" -H "$GH_VERSION" \
  -d "$(jq -n --arg l "$LABEL" '{labels:[$l]}')" \
  "https://api.github.com/repos/$OWNER/$NAME/issues/$ISSUE_NUMBER/labels"

curl -s -X DELETE -H "$GH_AUTH" -H "$GH_ACCEPT" -H "$GH_VERSION" \
  "https://api.github.com/repos/$OWNER/$NAME/issues/$ISSUE_NUMBER/labels/$LABEL"
```

If the label doesn't exist on the repo yet, the `POST .../labels` call returns 422. Create it first via `POST /repos/$OWNER/$NAME/labels {"name": "<label>"}` — the adapter at `symphony/scripts/ticket-systems/github-projects.mts` does this with `ensureRepoLabel()` and is the canonical reference.

### Transition state (GraphQL)

See the **State transitions** section above. There is no REST endpoint for setting a ProjectV2 single-select field — GraphQL is the only path.

---

## Ticket format

Same Markdown template Linear and Jira tickets use (see `$SKILLS_ROOT/linear/SKILL.md` under `## Ticket format`). GitHub renders the markdown directly in the Issue body — no syntax conversion needed.
