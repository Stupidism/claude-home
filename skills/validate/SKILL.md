---
name: validate
description: Run lint, unit tests, self-review checklist, and wait for CI to pass. Use after implementation and before creating or updating a PR.
---

# Validate

## Step 0 — TypeScript Check (run after every implementation phase)

```bash
pnpm exec tsc --noEmit --skipLibCheck 2>&1 | tail -20
```

Fix all type errors before proceeding. Do not defer them to CI.

## Step 1 — Lint & Unit Tests

```bash
nx affected --target=lint --base=origin/master
nx affected --target=test --base=origin/master
```

**Do not skip lint.** Fix all errors. Review all warnings.

## Step 2 — Self-review Checklist

- [ ] Every Acceptance Criterion from the ticket is met (check each one explicitly)
- [ ] No cross-scope illegal imports
- [ ] App-specific checklist items from `<nx-project-path>/WORKFLOW.md` (if any)
- [ ] All temporary proof edits have been reverted
- [ ] E2E tests target the correct dev server — MFE sub-apps are **not standalone**, they must be tested against the host app (`ws-mfe-parent:host`)

## Step 3 — Wait for CI (after push)

> **HARD STOP: Do not proceed to Human Review while any CI check is pending, queued, or running.**

```bash
PR_NUMBER=$(gh pr view --json number --jq '.number')
gh pr checks "$PR_NUMBER" --watch
gh pr checks "$PR_NUMBER"
```

If any check is still `pending` or `in_progress` after `--watch` returns, run `--watch` again.

**On failure:** fix locally, re-run Step 1, push, and repeat Step 3.
