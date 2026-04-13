# claude-home

A personal Claude Code configuration repo — global instructions, an autonomous agent system (Symphony), and shared skills, all version-controlled and portable across machines.

**Want to set up your own?** Fork this repo, point `~/.claude` at your fork, and customize for your stack. The Symphony system is designed to be team- and repo-agnostic: add your own board config under `symphony/config/boards/` and it works with any Linear team and any git repo.

## Structure

```
~/.claude/
  CLAUDE.md          — Global Claude Code instructions (language, autonomous mode detection)
  WORKFLOW.md        — Symphony agent workflow template (injected into each agent session)
  skills/            — Shared skills usable by both interactive and Symphony sessions
  symphony/          — Symphony autonomous agent system (see symphony/README.md)
  memory/            — Persistent memory across Claude sessions (auto-managed)
```

## Setup

### 1. Fork and clone

**Fork** `Stupidism/claude-home` on GitHub, then clone your fork:

```bash
git clone git@github.com:YOUR_USERNAME/claude-home.git ~/.claude
```

> If `~/.claude` already exists (Claude Code creates it on first run), move or merge it first:
> ```bash
> mv ~/.claude ~/.claude.bak
> git clone git@github.com:YOUR_USERNAME/claude-home.git ~/.claude
> cp -n ~/.claude.bak/settings.json ~/.claude/  # restore local settings if needed
> ```

### 2. Install Symphony dependencies

```bash
cd ~/.claude/symphony && npm install
```

### 3. Add secrets

```bash
cp ~/.claude/symphony/secrets.env.example ~/.claude/symphony/secrets.env
# Edit secrets.env and fill in LINEAR_API_KEY
```

### 4. Customize for your setup

- **`symphony/config/symphony.json`** — set `assigneeId` to your Linear user ID
- **`symphony/config/boards/`** — replace or add board files for your Linear teams and repos
- **`CLAUDE.md`** — update language preferences and any personal rules
- **`skills/`** — add, remove, or edit skills to match your workflow

The Workstream-specific board (`boards/wor.json`) and skills are included as a reference implementation. Adapt or delete them as needed.

---

## Skills

Skills live in `~/.claude/skills/`. Each skill is a Markdown file read by the agent at runtime.

- **Interactive skills** (called via Skill tool in Claude Code): `commit-changes`, `create-pr`, `start-feature`, etc.
- **Symphony skills** (called autonomously): `linear`, `read-and-plan`, `setup-worktree`, `validate`, etc.
- Some skills (e.g. `deploy-mfe`, `debug-mfe`) are shared and work in both modes.

---

## What's gitignored

Runtime data, caches, and secrets are excluded — see `.gitignore`. The `settings.json` (Claude Code local settings) is also excluded since it's machine-specific.
