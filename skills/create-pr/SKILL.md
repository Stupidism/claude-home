---
name: create-pr
description: Create a PR with the correct title format, structured body, and work items diff.
---

# Create PR

## Context

Read `$TICKET_ID`, `$TICKET_TITLE`, `$GITHUB_REPO` from the environment. Derive scope from the Nx project path of changed files.

## PR Title

Format: `type(scope): description [TICKET_ID]`

The PR title **must** match this format — `lint-pr.yml` validates it.

## PR Body

```markdown
## Background

{Summarize what was changed and why, drafted from git log and diff}

Issue ref: TICKET_ID

## Work items

\```diff
+ Added ...
- Removed ...
~ Updated ...
\```
```

Draft from `git log master..HEAD` and `git diff master...HEAD`. Do not ask for confirmation — submit directly.

## Creating the PR

```bash
gh pr create --title "type(scope): description [TICKET_ID]" --body "$(cat <<'EOF'
## Background

{description}

Issue ref: TICKET_ID

## Work items

\```diff
{work items}
\```
EOF
)"
```

## Post-Creation

After creating: print the PR URL, then run `$SKILLS_ROOT/submit-for-review/SKILL.md`.
