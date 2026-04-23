# claude-home

A personal Claude Code configuration repo — global instructions, an autonomous agent system (Symphony), and shared skills, all version-controlled and portable across machines.

**Want to set up your own?** Fork this repo, then use the setup below to point your home directory at your fork. The Symphony system is designed to be team- and repo-agnostic: add your own board config under `symphony/config/boards/` and it works with any Linear team and any git repo.

## Structure

This repo lives at `~` (your home directory). The `.gitignore` whitelists only what belongs in version control — everything else in your home directory is ignored.

```
~/
  README.md          — This file (shown on GitHub)
  .claude/
    CLAUDE.md        — Global Claude Code instructions (language, autonomous mode detection)
    WORKFLOW.md      — Symphony agent workflow template (injected into each agent session)
    skills/          — Shared skills usable by both interactive and Symphony sessions
    memory/          — Persistent memory across Claude sessions (auto-managed, gitignored)
  symphony/
    config/          — Your personal board configs (boards/*.json, symphony.json) — gitignored
    config-example/  — Template configs to copy from when setting up a new board
    scripts/         — Poller, runner, and PTY wrapper
    secrets.env      — LINEAR_API_KEY (gitignored)
```

## Setup

### 1. Fork and initialize

**Fork** `Stupidism/claude-home` on GitHub, then initialize your home directory as a git repo pointing at your fork:

```bash
cd ~
git init
git remote add origin git@github.com:YOUR_USERNAME/claude-home.git
git fetch
git checkout main
```

> If `~/.claude` already has files you want to keep (Claude Code creates it on first run), the checkout will merge cleanly — `.gitignore` ignores everything that isn't part of this repo.

### 2. Install Symphony dependencies

```bash
cd ~/symphony && npm install
```

### 3. Add secrets

```bash
cp ~/symphony/secrets.env.example ~/symphony/secrets.env
# Edit secrets.env and fill in LINEAR_API_KEY
```

### 4. Configure your board

Copy the example board config and customize it for your Linear team and repos:

```bash
cp -r ~/symphony/config-example/boards/ ~/symphony/config/boards/
# Edit config/boards/*.json with your real Linear team ID, state UUIDs, and repo paths
```

Copy and fill in the symphony config:

```bash
cp ~/symphony/config-example/symphony.json ~/symphony/config/symphony.json
# Edit config/symphony.json — set assigneeId to your Linear user UUID
# Set `remoteControl` to `true` to view task progress in Claude Code Desktop or Claude Code Web.
# Remember to enable the --dangerously-skip-permissions (run `claude --dangerously-skip-permissions`) in the project folder to make the claude can complete the task without any permission issue if you never use it before.
```

### 5. Customize further

- **`~/.claude/CLAUDE.md`** — update language preferences and any personal rules
- **`~/.claude/skills/`** — add, remove, or edit skills to match your workflow

The Workstream-specific board (`symphony/config/boards/wor.json`) is included as a reference implementation. Adapt or delete it as needed. Update the PrimaryRepo of a project if you need.

---

## Skills

Skills live in `~/.claude/skills/`. Each skill is a Markdown file read by the agent at runtime.

- **Interactive skills** (called via Skill tool in Claude Code): `commit-changes`, `create-pr`, etc.
- **Symphony skills** (called autonomously): `linear`, `read-and-plan`, `setup-worktree`, `validate`, etc.
- Some skills (e.g. `deploy-mfe`, `debug-mfe`) are shared and work in both modes.

---

## What's gitignored

The root `.gitignore` ignores everything (`*`) and then whitelists only:

- `.claude/` — skills, CLAUDE.md, WORKFLOW.md (runtime data inside is excluded by `.claude/.gitignore`)
- `symphony/` — scripts and config-example (secrets and logs inside are excluded by `symphony/.gitignore`)
- `README.md` — this file

Machine-specific settings (`settings.json`, `symphony/config/`) and secrets are always excluded.
