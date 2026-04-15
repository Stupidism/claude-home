---
name: sync-projects
description: Fetch all Linear projects for a board, match each to a code repo or monorepo sub-path, and merge new entries into the board config. Run whenever new Linear projects have been created and the board config does not yet include them.
---

# Sync Linear Projects → board config

## When to run

Use this skill after a new Linear project is created and you need to add it to
`$SYMPHONY_ROOT/config/boards/<board>.json`.

---

## Step 1 — Identify the board file and fetch all Linear projects

```bash
LINEAR_API_KEY="${LINEAR_API_KEY:-$(grep LINEAR_API_KEY $SYMPHONY_ROOT/secrets.env | cut -d= -f2)}"

# List available board configs and pick the right one
ls $SYMPHONY_ROOT/config/boards/*.json | grep -v example

# Set BOARD_FILE to the relevant board config, e.g.:
# BOARD_FILE="${SYMPHONY_ROOT}/config/boards/<board>.json"
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

This prints every project's UUID and name.

---

## Step 2 — Find projects not yet in the board config

```bash
EXISTING_IDS=$(node -e "
  const base = JSON.parse(require('fs').readFileSync('$BOARD_FILE','utf8'));
  const all = (base.projects||[]).map(p => p.linearProjectId);
  process.stdout.write(all.join('\n'));
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

Apply these rules in order for each unmapped Linear project:

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
// New entries to add to the "projects" array in $BOARD_FILE:
{
  "linearProjectId": "<uuid-from-step-1>",
  "name": "<Linear project name>",
  "primaryRepo": "$REPO_NAME",
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

Add each new entry to the `projects` array in `$BOARD_FILE` (only projects whose `linearProjectId` is not already present):

```bash
node -e "
  const fs = require('fs');
  const config = JSON.parse(fs.readFileSync('$BOARD_FILE', 'utf8'));
  const existing = new Set((config.projects||[]).map(p => p.linearProjectId));
  const newEntries = [/* paste generated entries here */];
  const toAdd = newEntries.filter(p => !existing.has(p.linearProjectId));
  config.projects = [...(config.projects||[]), ...toAdd];
  fs.writeFileSync('$BOARD_FILE', JSON.stringify(config, null, 2) + '\n');
  console.log('Added', toAdd.length, 'project(s):', toAdd.map(p => p.name).join(', '));
"
```

---

## Notes

- The poller (`poll-linear.mts`) reads the board config at startup — restart it after editing.
- When a project is renamed in Linear, update the `name` field here to match.
