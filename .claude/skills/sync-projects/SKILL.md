---
name: sync-projects
description: Fetch all projects for a board (Linear projects or Jira `project:*` labels), match each to a code repo or monorepo sub-path, and merge new entries into the board config. Run whenever new projects/labels have been created and the board config does not yet include them.
---

# Sync Projects → board config

Works for both ticket systems. The board file's `ticketSystem` field decides how projects are discovered:

| `ticketSystem` | Project source |
|---|---|
| `linear` | Linear's `team.projects` GraphQL query (each project has a UUID) |
| `jira` | Distinct `project:<name>` labels used on the board's tickets (the `<name>` slug is the identifier) |

The downstream steps (matching to repo paths, generating entries, merging into the config) are the same once you have the project list.

## When to run

Use this skill after a new project (Linear) or `project:*` label (Jira) is introduced and you need to add it to `$SYMPHONY_ROOT/config/boards/<board>.json`.

---

## Step 1 — Identify the board file and fetch all projects

```bash
# List available board configs and pick the right one
ls $SYMPHONY_ROOT/config/boards/*.json | grep -v example

# Set BOARD_FILE to the relevant board config, e.g.:
# BOARD_FILE="${SYMPHONY_ROOT}/config/boards/<board>.json"
TICKET_SYSTEM=$(node -e "process.stdout.write(JSON.parse(require('fs').readFileSync('$BOARD_FILE','utf8')).ticketSystem||'linear')")
echo "ticketSystem=$TICKET_SYSTEM"
```

### Linear boards

Prefer `mcp__linear-server__list_projects` (filter by team) when available. Curl fallback:

```bash
LINEAR_API_KEY="${LINEAR_API_KEY:-$(grep LINEAR_API_KEY $SYMPHONY_ROOT/secrets.env | cut -d= -f2)}"

TEAM_ID=$(node -e "process.stdout.write(JSON.parse(require('fs').readFileSync('$BOARD_FILE','utf8')).teamId)")

curl -s -X POST https://api.linear.app/graphql \
  -H "Authorization: $LINEAR_API_KEY" \
  -H "Content-Type: application/json" \
  -d "{\"query\": \"{ team(id: \\\"${TEAM_ID}\\\") { projects { nodes { id name } } } }\"}" \
  | node -e "
    const d = JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));
    d.data.team.projects.nodes.forEach(p => console.log(p.id, p.name));
  "
```

This prints every Linear project's UUID and name.

### Jira boards

Jira doesn't expose a "project" concept that matches Symphony's notion — Symphony uses `project:<name>` labels on issues to map a ticket to a `projects[]` entry. Discover the distinct labels in use by querying recent issues:

Preferred: `mcp__mcp-atlassian__jira_search` with JQL `project = <ticketPrefix> AND labels in ("project:*")` and request `labels` in `fields`. Curl fallback (see `$SKILLS_ROOT/jira/SKILL.md` for the auth header):

```bash
JIRA_BASE_URL=$(jq -r '.jira.baseUrl' "$BOARD_FILE")
PROJECT_KEY=$(jq -r '.ticketPrefix' "$BOARD_FILE")

curl -s -H "Authorization: $JIRA_AUTH" -H "Accept: application/json" \
  "$JIRA_BASE_URL/rest/api/3/search?jql=project%3D${PROJECT_KEY}&fields=labels&maxResults=200" \
  | node -e "
    const d = JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));
    const slugs = new Set();
    for (const issue of d.issues||[]) {
      for (const l of issue.fields?.labels||[]) {
        if (l.startsWith('project:')) slugs.add(l.slice('project:'.length));
      }
    }
    [...slugs].sort().forEach(s => console.log('project:' + s, s));
  "
```

The left column (`project:<name>`) is the identifier you'll store; the right column (`<name>`) is the human-readable slug to use when matching repo paths.

---

## Step 2 — Find projects not yet in the board config

Each `projects[]` entry in the board config carries a system-specific identifier. The existing field name varies by board:

- Linear boards store the project UUID under `projects[].linear.projectId` (or the legacy `projects[].linearProjectId`).
- Jira boards store the matching `project:<name>` label under `projects[].jira.projectLabel` (or `projects[].linearProjectId` reused as a flat string — match `read-and-plan`'s lookup logic in the same board file).

```bash
EXISTING_IDS=$(node -e "
  const base = JSON.parse(require('fs').readFileSync('$BOARD_FILE','utf8'));
  const all = (base.projects||[]).map(p => p.linear?.projectId || p.linearProjectId || p.jira?.projectLabel);
  process.stdout.write(all.filter(Boolean).join('\n'));
")
echo "Already mapped project IDs:"
echo "$EXISTING_IDS"
```

Compare against the list from Step 1 to identify unmapped projects.

---

## Step 3 — Discover monorepo paths

```bash
MONO_ROOT=$(node -e "
  const base = JSON.parse(require('fs').readFileSync('$BOARD_FILE','utf8'));
  const monoRepo = base.repos.find(r => r.isMono);
  process.stdout.write(monoRepo ? monoRepo.path.replace('~', process.env.HOME) : '');
")

echo "=== apps/ ==="
ls "$MONO_ROOT/apps/" 2>/dev/null | sort

echo "=== libs/ ==="
ls "$MONO_ROOT/libs/" 2>/dev/null | sort
```

---

## Step 4 — Match projects to paths (inference rules)

Apply these rules in order for each unmapped project (use the Linear name or the Jira `<slug>`):

1. **Exact name match** — normalize both sides: lowercase, replace spaces/hyphens/underscores with nothing.
   - `ws-components` → `wscomponents` matches `libs/ws-components` → `wscomponents`
   - `On-Demand Interviews` → `ondemandinterviews` matches `apps/on-demand-interviews` → `ondemandinterviews`

2. **Prefix/substring match** — if the project name is contained in a path segment or vice versa (after normalization).

3. **No match** — mark as `UNMATCHED`; the user must supply the path manually.

For each match, determine:
- Whether the path is under `apps/` (typically `primaryRepo` is the monorepo name) or a separate repo
- A one-sentence `hint` describing the sub-app's purpose (read the directory's `README.md` or `project.json` if available)

---

## Step 5 — Read hints from project.json

For each matched app/lib:

```bash
cat "$MONO_ROOT/apps/<name>/project.json" 2>/dev/null | node -e "
  const d = JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));
  console.log(d.name, d.tags);
" || echo "(no project.json)"
```

Use the `name` and `tags` fields to compose a `hint` sentence.

---

## Step 6 — Generate new project entries

Determine the current repo name:

```bash
# $GITHUB_REPO is injected by Symphony (e.g. "acme/my-repo")
REPO_NAME="${GITHUB_REPO##*/}"
# If not in a Symphony session, fall back to reading the name from board config repos[] (Step 3)
```

For a monorepo match, `primaryRepo` is the monorepo's `name` field from the board config; for a standalone-repo match, use that repo's `name`. Use `$REPO_NAME` directly — do not hardcode it.

```jsonc
// New entries to add to the "projects" array in $BOARD_FILE.
// Use the identifier shape that the rest of the board file already uses
// (Linear: `linear.projectId` / legacy `linearProjectId`; Jira: `jira.projectLabel`).
{
  "name": "<project name or label slug>",
  "primaryRepo": "$REPO_NAME",
  "linear": { "projectId": "<uuid-from-step-1>" },           // Linear boards only
  // "jira":   { "projectLabel": "project:<slug>" },         // Jira boards only
  "repos": [
    {
      "name": "$REPO_NAME",
      "path": "<repo-path-from-board-config>/<apps-or-libs>/<dir-name>",
      "hint": "<one-sentence description of what this sub-app does>"
    }
  ]
}
// UNMATCHED projects appear as comments — user fills in manually
```

---

## Step 7 — Merge into board config

Add each new entry to the `projects` array in `$BOARD_FILE` (skip projects whose identifier is already present, regardless of which identifier shape the existing entry uses):

```bash
node -e "
  const fs = require('fs');
  const config = JSON.parse(fs.readFileSync('$BOARD_FILE', 'utf8'));
  const key = (p) => p.linear?.projectId || p.linearProjectId || p.jira?.projectLabel;
  const existing = new Set((config.projects||[]).map(key).filter(Boolean));
  const newEntries = [/* paste generated entries here */];
  const toAdd = newEntries.filter(p => !existing.has(key(p)));
  config.projects = [...(config.projects||[]), ...toAdd];
  fs.writeFileSync('$BOARD_FILE', JSON.stringify(config, null, 2) + '\n');
  console.log('Added', toAdd.length, 'project(s):', toAdd.map(p => p.name).join(', '));
"
```

---

## Notes

- The poller (`poll-tickets.mts`) reads each board config at startup — restart it after editing.
- When a project is renamed (Linear) or a label is renamed (Jira), update the `name` and identifier fields here to match.
