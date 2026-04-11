# Ticket: $TICKET_ID — $TICKET_TITLE

**Description:** $TICKET_DESC | **Ticket system:** $TICKET_SYSTEM

## Session context

- Repo root: `$REPO_ROOT`
- Worktree: `$WORKTREE_PATH`
- Branch: `$BRANCH`
- Run mode: $RUN_MODE

---

# Symphony Agent Workflow

> ⚠️ **TOOL BAN — read before using any tools:** The `mcp__linear-server` MCP tools are **banned in autonomous mode** — they require interactive OAuth which is unavailable here. **Never call any `mcp__linear-server__*` tool.** For Linear operations, use curl + `$LINEAR_API_KEY` as documented in `$SKILLS_ROOT/linear/SKILL.md`.

> **Language:** Two strict zones — never mix them.
>
> - **$PERSONAL_PREFERRED_LANGUAGE**: all conversational output (status updates, reasoning, explanations to the user).
> - **$WORK_PREFERRED_LANGUAGE**: everything that lands in the repo or ticket system — code comments, commit messages, PR titles/bodies, ticket comments, workpad entries.
> - Never use $NEVER_USE_LANGUAGE for anything.

> **Ticket system:** `$TICKET_SYSTEM`. If linear → use `$SKILLS_ROOT/linear/SKILL.md` (curl + `$LINEAR_API_KEY`) for all API operations. **Do NOT use the Linear MCP server** — it requires OAuth which is unavailable in autonomous mode. If jira → use the Jira MCP tools. **Never mix** ticket systems. **If ticket fetch fails, stop immediately and report the error — do not guess requirements from the title or codebase.**

> **Autonomous mode:** Never ask a human to follow up. Use `$SKILLS_ROOT/commit/SKILL.md` and `$SKILLS_ROOT/create-pr/SKILL.md` — not the standard interactive skills.

> **Project rules:** Check `<nx-project-path>/WORKFLOW.md` for app-specific rules that supplement this workflow.

---

## State Routing

| State          | Action                                                                                  |
| -------------- | --------------------------------------------------------------------------------------- |
| `Backlog`      | **Stop. Do not touch.**                                                                 |
| `Todo`         | Read `$SKILLS_ROOT/read-and-plan/SKILL.md` → `setup-worktree` → begin work           |
| `In Progress`  | Resume from workpad                                                                     |
| `Human Review` | Wait. Do not code.                                                                      |
| `In Review`    | Wait. Do not code.                                                                      |
| `Rework`       | Read `$SKILLS_ROOT/rework/SKILL.md`                                                  |
| `Merging`      | Invoke `land` skill via Skill tool. Do NOT move to Done — poller does it after you exit |
| `Done`         | Shut down.                                                                              |

---

## Workflow Steps

1. **Read & Plan** — read `$SKILLS_ROOT/read-and-plan/SKILL.md` (skip if resuming)
2. **Setup Worktree** — read `$SKILLS_ROOT/setup-worktree/SKILL.md` (skip if resuming)
3. **Implement** — read source first, reproduce first, check app-specific WORKFLOW. Revert temp edits before committing. Out-of-scope items → file new ticket in Backlog.
   - **Explore efficiently:** Use Grep to locate symbols before reading files. Use LSP diagnostics (`get_diagnostics`) to find type errors instead of re-reading type definitions. Do not Read the same file twice without having edited it in between.
   - **Map before you edit:** For tasks touching more than 5 files, list all affected files in the workpad before making any edits. Work through them in a single pass.
   - **Phase checkpoints:** Group related edits into logical phases (e.g. types → components → tests). Run `pnpm exec tsc --noEmit` after each phase before moving on.
4. **Validate** — read `$SKILLS_ROOT/validate/SKILL.md`
5. **Rebase & Create PR** — rebase (`$SKILLS_ROOT/rebase-latest-master/SKILL.md`), create PR (`$SKILLS_ROOT/create-pr/SKILL.md`, ensure `symphony` label), invoke `check-pr` skill, wait for CI
6. **Submit** — proof of work, then `$SKILLS_ROOT/pr-feedback-sweep/SKILL.md`, then `$SKILLS_ROOT/submit-for-review/SKILL.md`
7. **Merge** — invoke `land` skill. Exit immediately. Do NOT move ticket to Done.
