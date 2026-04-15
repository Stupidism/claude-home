---
name: commit-changes
description: Use when the user says "commit", "commit changes", "save progress", or wants to create a git commit. Composes a conventional commit message with the correct scope and ticket ID.
---

# Commit Changes

Create a well-formatted conventional commit with the correct scope and ticket ID.

## Gathering Context

1. Read `$SKILLS_ROOT/prime-project/session-state.md` for:
   - **Ticket ID** — if not found, ask the user
   - **Project name** — to load the project config

2. Read `$SKILLS_ROOT/prime-project/project-configs/{project-name}.json` for:
   - **commitScope** — the scope to use in the commit message

3. If neither session state nor project config is available, ask the user for the scope and ticket ID directly. The skill works standalone.

## claude-home Repo

When working in the claude-home repo (detected when the git remote is `claude-home` or the repo root is `~`), only stage whitelisted paths — the home directory contains non-repo files that must never be staged:

```bash
git add .claude/ symphony/ README.md
```

Do **not** use `git add -u` or `git add .` for the home directory.

## Composing the Commit Message

Format: `type(scope): description [TICKET-ID]`

**Valid types:** Conventional commits! - `feat`, `fix`, `refactor`, `chore`, `docs`, `style`, `test`, `perf`, `ci`, `build`

**Rules:**

- **Scope is MANDATORY** — enforced by commitlint (`scope-empty: never`). Never omit it.
- If a project config is loaded, use its `commitScope`
- If no project config, determine scope from what was changed:
  - Changes in `apps/<name>/` → use `<name>` as scope
  - Changes in `libs/<name>/` → use `<name>` as scope
  - Changes in `routes/<name>/` → use `<name>` as scope
  - Repo-wide/root-level changes → use one of: `root`, `repo`, `workspace`, `ci`
  - Multiple projects affected → use the primary project, mention others in the body
- ticket ID in square brackets at the end
- Description is lowercase, imperative mood, no period at the end
- Body max line length: 200 characters

**Examples:**

```
feat(payroll-backend): add processing period support [PAYR-1234]
fix(payroll-backend): correct tax calculation for overtime [PAYR-5678]
test(payroll-backend): add integration tests for payroll preview [PAYR-4503]
chore(repo): update commitlint config [WS-1234]
ci(ci): add new GitHub Actions workflow [WS-5678]
```

## Pre-Commit Steps

1. Run `git status` and `git diff --staged` to understand changes
2. If nothing is staged, ask the user what to stage
3. Draft the commit message and **show it to the user for confirmation** before committing
4. **Node version manager**: If this is the first commit in the session, detect the version manager by running `which mise nvm fnm node`. If undetected, ask the user. Git hooks require the same node version as the repo package.json. Store the answer in session state.

## Committing

- **NEVER** use `--no-verify` — if hooks fail, fix the underlying issue
- If using a version manager, wrap the command:
  - mise: `mise exec -- git commit -m "..."`
  - nvm: `. ~/.nvm/nvm.sh && nvm use && git commit -m "..."`
  - fnm: `eval "$(fnm env)" && fnm use && git commit -m "..."`
  - asdf: `asdf exec git commit -m "..."`

## Post-Commit

- If branches have diverged and a push is needed, **ask before force pushing** — prefer `--force-with-lease`
- Update the **Phase** field in `$SKILLS_ROOT/prime-project/session-state.md` to `implementing` or `testing` as appropriate
- Suggest: "Ready to create a PR? Use `create-pr`."
