# Symphony Configuration

Symphony reads its runtime configuration from `~/symphony/config/`:

- `symphony.json` — global defaults (assignee, poll cadence, language preferences, Slack defaults).
- `boards/<board>.json` — one file per Linear/Jira board (e.g. `up.json`, `wor.json`).

`config/` is gitignored. The `config-example/` directory in this repo is the schema reference; copy entries into `config/` and fill in your IDs.

## Layered resolution

Configuration is grouped by external system (`slack`, `github`, `linear`, `jira`) and deep-merged across **three levels**:

```
symphony.json   →   boards/<board>.json   →   projects[*]   →   (repos[*] for slack)
   (global)            (board)                 (project)         (repo)
```

Later levels override earlier ones key-by-key for nested objects; arrays and primitives are replaced wholesale.

The poller calls `resolveSlack(symphony, board, project?, repo?)` to compose the final `slack` block and `resolveGithub(...)` for the `github` block. Skills (e.g. `notify-review`) read the resolved view directly when posting review notifications.

## Schema

### `symphony.json` (global)

```json
{
  "assigneeId": "<Linear user UUID>",
  "maxConcurrent": 5,
  "pollIntervalSeconds": 30,
  "remoteControl": true,
  "preferences": {
    "personalLanguage": "English",
    "workLanguage": "English",
    "neverUseLanguage": ""
  },
  "slack": {
    "codeReviewChannel": { "name": "#e-code-review", "id": "C0123ABCD" },
    "reviewers": {
      "wenkang": "U0123ABCD",
      "smith":   "U4567WXYZ"
    }
  }
}
```

### `boards/<board>.json` (one per board)

Common fields at the top level:

- `name` — display name (e.g. `"UP"`, `"Workstream"`).
- `ticketPrefix` — uppercase ticket prefix (`"UP"`, `"WOR"`).
- `ticketSystem` — `"linear"` (default) or `"jira"`.
- `teamId` — Linear team UUID, or Jira project key (e.g. `"UP"`).
- `assigneeId` — optional per-board override of the global `assigneeId`. Required when the board's backend differs from the global default's backend (e.g. Jira board on a Linear-default install).
- `defaultRepo` — repo name to use when no project entry matches.
- `repos[]` — repos this board can operate on.
- `projects[]` — Symphony project entries; tickets are routed to one of these based on `linear.projectId` / `jira.projectLabel`.

#### Linear board block

```json
{
  "ticketSystem": "linear",
  "teamId": "<linear-team-uuid>",
  "linear": {
    "states": {
      "backlog":     "<uuid>",
      "todo":        "<uuid>",
      "inProgress":  "<uuid>",
      "humanReview": "<uuid>",
      "rework":      "<uuid>",
      "merging":     "<uuid>",
      "done":        "<uuid>"
    }
  }
}
```

#### Jira board block

```json
{
  "ticketSystem": "jira",
  "teamId": "UP",
  "jira": {
    "baseUrl": "https://<site>.atlassian.net",
    "states": {
      "backlog":     "Backlog",
      "todo":        "To Do",
      "inProgress":  "In Progress",
      "humanReview": "Human Review",
      "rework":      "Rework",
      "merging":     "Merging",
      "done":        "Done"
    },
    "transitions": {
      "backlog":     "<numeric transition id>",
      "todo":        "<numeric transition id>",
      "inProgress":  "<numeric transition id>",
      "humanReview": "<numeric transition id>",
      "rework":      "<numeric transition id>",
      "merging":     "<numeric transition id>",
      "done":        "<numeric transition id>"
    }
  }
}
```

Get Jira transition IDs with:

```bash
curl -u "$JIRA_EMAIL:$JIRA_API_TOKEN" "https://<site>.atlassian.net/rest/api/2/issue/<KEY>/transitions"
```

#### `slack` block (any level)

```json
{
  "slack": {
    "codeReviewChannel": { "name": "#e-code-review", "id": "C0123ABCD" },
    "crossPost":         { "name": "#team-frontend", "id": "C9876ZYXW" },
    "reviewers": {
      "wenkang": "U0123ABCD"
    }
  }
}
```

#### `github` block (any level)

```json
{
  "github": {
    "codeReviewComment": "@your-github-actions-bot review"
  }
}
```

`codeReviewComment` is the comment Symphony posts on a new PR to trigger an external AI reviewer. Set to empty string `""` at any level to disable AI review there specifically. When unset across all levels, AI review is skipped.

#### `repos[]` entries

```json
{
  "name": "workstream-mono",
  "path": "~/Documents/workstream-mono",
  "worktreesDir": "~/Documents/workstream-mono-worktrees",
  "defaultBranch": "master",
  "githubRepo": "your-org/workstream-mono",
  "isMono": true,
  "github": { "codeReviewComment": "@codex review in short words" },
  "setup": {
    "symlinkNodeModules": true,
    "installCommand": "CI=true pnpm install --frozen-lockfile --quiet",
    "installCheck": "pnpm-lock.yaml"
  }
}
```

#### `projects[]` entries

Each project entry routes one Linear project / Jira label to a primary repo and zero or more secondary repos.

```json
{
  "name": "Symphony",
  "primaryRepo": "claude-home",
  "linear": { "projectId": "<linear-project-uuid>" },
  "jira":   { "projectLabel": "project:symphony" },
  "slack":  { "codeReviewChannel": { "name": "#proj-symphony", "id": "C111..." } },
  "repos": [
    {
      "name": "claude-home",
      "path": "~/symphony",
      "hint": "Symphony agent system scripts and config — all workflow changes live here"
    }
  ]
}
```

Only the system block matching the board's `ticketSystem` is consulted at routing time: a Linear board reads `linear.projectId`, a Jira board reads `jira.projectLabel`.

## Migrating from the flat schema

The pre-UP-761 schema kept `states`, `transitions`, `jiraBaseUrl`, `linearProjectId`, and `code-review-comment` as top-level keys, and per-repo `code-review-comment` overrides at the root of each `repos[]` entry. The new shape moves each into the appropriate `slack` / `github` / `linear` / `jira` block. The repo's `owner/repo` slug field was renamed from `github` to `githubRepo` to avoid colliding with the new per-repo `github` namespace. The behaviour the poller exposes (ticket fetch, state transitions, AI review trigger) is unchanged; only the keys you write in JSON have moved.
