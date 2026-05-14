# Symphony

Autonomous agent system that polls Linear or Jira tickets and processes them with Claude Code in isolated git worktrees.

## How it works

1. **Poller** (`scripts/poll-tickets.mts`) polls all configured boards every 30s
2. When a ticket moves to **Todo**, the poller claims it (→ In Progress) and spawns an agent
3. **Runner** (`scripts/run-ticket.sh`) creates a git worktree, sets up the environment, and launches `claude`
4. The agent reads `~/.claude/WORKFLOW.md` and executes the full dev cycle: plan → implement → validate → PR → submit for review
5. When the PR is approved, the ticket moves to **Merging** and the agent lands it

## Directory structure

```
symphony/
  config/
    symphony.json          — Global settings (assignee, concurrency, language preferences)
    boards/
      wor.json             — Workstream board (Linear team, state IDs, repos, projects)
  scripts/
    poll-tickets.mts       — Multi-board poller (TypeScript, Node 22+)
    poll-linear.mts        — Back-compat shim that imports poll-tickets.mts
    run-ticket.sh          — Project-agnostic agent runner
    pty-wrapper.py         — Spawns claude --remote-control in a PTY (for claude.ai session visibility)
  secrets.env              — gitignored — LINEAR_API_KEY goes here
  package.json             — { "type": "module", deps: chalk, cli-table3 }
```

## Setup

### Prerequisites

- Node.js 22+
- `claude` CLI installed and authenticated (`claude --version`)
- Linear API key (Personal API keys → https://linear.app/settings/api)

### Install dependencies

```bash
cd ~/symphony && npm install
```

### Secrets

```bash
echo "LINEAR_API_KEY=lin_api_YOUR_KEY_HERE" > ~/symphony/secrets.env
```

### Configure

**`config/symphony.json`** — set your `assigneeId` (Linear user UUID):

```bash
# Get your Linear user ID
source ~/symphony/secrets.env
curl -s -X POST https://api.linear.app/graphql \
  -H "Authorization: $LINEAR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"query": "{ viewer { id name } }"}' \
  | node -e "const d=JSON.parse(require('fs').readFileSync('/dev/stdin','utf8')); console.log(d.data.viewer.id, d.data.viewer.name)"
```

**`config/boards/*.json`** — one file per Linear team. See `boards/wor.json` as reference.

## Running

```bash
# From workstream-mono (recommended)
pnpm symphony

# Or directly
cd ~/symphony && node --experimental-strip-types scripts/poll-tickets.mts

# Dry run — polls each board and prints what would be spawned, no agents started
cd ~/symphony && node --experimental-strip-types scripts/poll-tickets.mts --dry-run
```

Only one poller instance is allowed. If already running, it will print the existing PID and exit.

The poller watches `scripts/` and `config/` and hot-reloads itself on any change — edit a script or config file and it will re-exec automatically. Running agent subprocesses are preserved across the restart (the PID-file check prevents duplicate spawns).

## Board config schema

Each board file (`config/boards/*.json`) defines:

| Field | Description |
|-------|-------------|
| `teamId` | Linear team UUID |
| `ticketPrefix` | e.g. `WOR` |
| `ticketSystem` | `linear` or `jira` |
| `states` | Map of state names → Linear state UUIDs |
| `defaultRepo` | Fallback repo name when ticket has no project |
| `defaultRuntime` | `claude` (default) or `codex`. Overridden per-ticket by `runtime:<name>` label. |
| `repos[]` | All git repos this board can touch (path, github, setup config) |
| `projects[]` | Linear projects → repo mapping, with per-repo `hint` for the agent |

### Ticket → repo resolution

1. Look up `ticket.project.id` in `projects[].linearProjectId`
2. Use `project.primaryRepo` as the worktree base
3. Pass `project.repos[0].path` as `PROJECT_PATH` (monorepo entry point for the agent)
4. Fall back to `board.defaultRepo` if no project match

## Environment variables injected into each agent session

| Variable | Source |
|----------|--------|
| `SYMPHONY=true` | Signals Claude Code to follow `~/.claude/WORKFLOW.md` |
| `TICKET_ID`, `TICKET_TITLE`, `TICKET_DESC` | From Linear ticket |
| `TICKET_SYSTEM` | From board config (`linear` / `jira`) |
| `REPO_ROOT`, `WORKTREE_PATH`, `BRANCH` | Derived from repo config |
| `GITHUB_REPO` | `owner/repo` slug (e.g. `helloworld1812/workstream-mono`) |
| `PROJECT_PATH` | Monorepo subfolder entry point for the ticket's project |
| `SYMPHONY_ROOT` | `~/symphony` |
| `SKILLS_ROOT` | `~/.claude/skills` |
| `STATE_*` | All Linear state UUIDs from the board config |
| `LINEAR_API_KEY` | From `secrets.env` |

## Choosing the agent runtime

Symphony spawns one of two agent CLIs per ticket:

| Runtime | When to use | How it spawns |
|---------|-------------|---------------|
| `claude` (default) | Most tickets. Required for anything that depends on claude.ai/agents session visibility, hooks, or the existing skills under `~/.claude/skills/`. | Via `pty-wrapper.py` when `remoteControl: true`, otherwise direct `claude --print`. Manages `.claude-session-id` for resume. |
| `codex` | Fallback when claude is unhealthy (rate limit pause, stale session id loops). Independent invocations — no resume, no remote-control, no pty. | Direct `codex exec` with stdio inherited from the poller's per-ticket log. Skills resolved by codex itself under `~/.codex/skills/`. |

Resolution order (highest priority first):

1. **Per ticket** — `runtime:codex` label (Jira label or Linear label) on the ticket.
2. **Per board** — `defaultRuntime: "codex"` in `config/boards/*.json`.
3. **Per machine** — `defaultRuntime: "codex"` in `config/symphony.json`. Useful for personal machines that should prefer codex when boards don't override.
4. Built-in `"claude"`.

Codex does not need `--remote-control` or a session-id file: the codex CLI shares state with the codex desktop app natively, and each invocation is independent. The poller pipes codex stdout/stderr into the same per-ticket log file (`logs/symphony-<ticket>.log`) that claude uses, so the dashboard tail and error surfacing work identically.

Override the codex binary or flags from the environment if needed:

```bash
CODEX_BIN=/opt/homebrew/bin/codex \
CODEX_FLAGS='--dangerously-bypass-approvals-and-sandbox' \
node --experimental-strip-types scripts/poll-tickets.mts
```

## Troubleshooting

**Agent doesn't read WORKFLOW.md**
→ Check that `SYMPHONY=true` is exported. Verify `~/.claude/CLAUDE.md` has the Symphony mode section.

**`Cannot find package 'chalk'`**
→ Run `cd ~/symphony && npm install`

**Poller says "Already running"**
→ Kill the existing process: `kill <PID>` then restart.

**Linear API errors**
→ Check `secrets.env` has a valid `LINEAR_API_KEY`. Test: `source secrets.env && curl -s -X POST https://api.linear.app/graphql -H "Authorization: $LINEAR_API_KEY" -H "Content-Type: application/json" -d '{"query":"{ viewer { name } }"}' | node -e "process.stdin.resume(); let d=''; process.stdin.on('data',c=>d+=c); process.stdin.on('end',()=>console.log(JSON.parse(d).data.viewer.name))"`
