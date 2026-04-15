---
name: run-tests
description: Use when the user says "run tests", "test this", "check if tests pass", "run unit tests", "run integration tests", or after completing implementation work. Also triggers when test failures need debugging and re-running. Make sure to use this skill whenever the user mentions testing, verifying changes work, or checking for regressions — even if they don't explicitly say "run tests".
---

# Run Tests

Execute tests with worktree safety, correct commands, and an automated regression loop for failures.

## Workflow

### Step 1: Worktree Safety Check

Before anything else, establish your environment and lock it down.

```bash
# Record where you are — you MUST stay here for the entire workflow
WORKTREE_PATH=$(git rev-parse --show-toplevel)
CURRENT_BRANCH=$(git branch --show-current)

# Detect if this is a linked worktree (not the main repo)
GIT_COMMON=$(git rev-parse --git-common-dir)
GIT_DIR=$(git rev-parse --git-dir)
IS_WORKTREE=$( [ "$GIT_COMMON" != "$GIT_DIR" ] && echo "yes" || echo "no" )
```

Read `$SKILLS_ROOT/run-tests/references/worktree-safety.md` for the full safety reference.

**If `IS_WORKTREE` is "yes"** — you are in a linked worktree. These rules are MANDATORY:

- NEVER run `git checkout master/main`, `git switch master/main`, or `cd` to another worktree path
- NEVER run `git stash` + switch + unstash (this contaminates other worktrees)
- NEVER attempt to "verify on master" by switching — use `git diff master...HEAD` instead
- ALL test commands MUST run from the current working directory

If you need to check whether a failure is pre-existing, use `git diff master...HEAD -- <failing-test-file>`. If the diff is empty, the test file hasn't changed — tell the user it's pre-existing.

**If `IS_WORKTREE` is "no"** — you are on a normal branch in the main repo. Switching branches to compare is acceptable if needed, though `git diff master...HEAD` is still the faster approach.

### Step 2: Gather Context

1. Read `$SKILLS_ROOT/prime-project/session-state.md` for the current project name, ticket ID, and phase
2. Read `$SKILLS_ROOT/prime-project/project-configs/{project-name}.json` for test commands
3. If no session state exists:
   - Infer project from the current directory (e.g., if `pwd` contains `apps/payroll-backend`, it's `payroll-backend`)
   - If ambiguous, ask the user which project to test
4. **Detect version manager** (first time only):
   - Check session state for a previously detected manager
   - If not cached: check for `.tool-versions` (mise or asdf), `.nvmrc` (nvm or fnm)
   - Ask the user which manager they use if multiple are possible
   - Store the result in session state under `Version Manager: {name}` so future runs don't need to ask again

### Step 3: Determine Test Scope

Choose the test scope based on user intent and context:

| Situation                                  | Scope                                                                      | Command key                              |
| ------------------------------------------ | -------------------------------------------------------------------------- | ---------------------------------------- |
| User says "run unit tests"                 | Unit only                                                                  | `commands.testUnit`                      |
| User says "run integration tests"          | Integration only                                                           | `commands.testIntegration`               |
| User says "test payrolls service"          | Specific pattern                                                           | `commands.testSpecific` with `{pattern}` |
| After implementation (no specific request) | Unit first, then integration if `.integration.spec.ts` files were modified | Both                                     |
| User says "run all tests" or "run tests"   | Unit then integration                                                      | Both sequentially                        |

Build the command from the project config. Apply the version manager prefix:

```bash
# Example for mise:
mise exec -- nx run payroll-backend:test:unit --testPathPattern=payrolls-v2.service
```

### Step 4: Run Tests

1. **Verify location**: confirm `pwd` still matches `$WORKTREE_PATH` from Step 1
2. Run the test command from the monorepo root
3. Capture the full output

### Step 5: Handle Results

#### All tests pass

1. Report the results: number of test suites, tests passed, duration
2. Update session state phase to `testing-complete`
3. Tell the user: "All tests pass. Ready to commit — use `commit-changes`."

#### Tests fail — regression loop

Enter the regression loop. **Maximum 3 iterations** before stopping and asking the user.

**Each iteration:**

1. **Parse failures** — identify:
   - Failing test file paths
   - Failing test names
   - Error messages and stack traces

2. **Read the code** — open the failing test files and the source files they test. (When you read test files, Claude Code rules for testing patterns will auto-inject into context — this is by design.)

3. **Diagnose** — determine the root cause:
   - Is it a code bug you introduced? → Fix the source code
   - Is it a test that needs updating for your changes? → Fix the test
   - Is it a nockBack fixture mismatch? → Follow the nockBack rules from the integration-tests rule (add `nock.emitter.on('no match', ...)`, fix only exact values, never add/remove entries)
   - Is it pre-existing? → Check with `git diff master...HEAD -- <test-file>`. If unchanged, tell the user and skip it

4. **Apply the fix** — make the minimal change needed

5. **Re-run** — run ONLY the failing tests using `--testPathPattern` to get fast feedback

6. **Evaluate**:
   - If the targeted tests now pass → continue to next failing test or proceed to full suite
   - If still failing → increment iteration counter, try again
   - If iteration 3 fails → **STOP**. Present your findings clearly:
     - Which tests are still failing
     - What you tried
     - Your best diagnosis of the remaining issue
     - Ask the user for guidance

7. **Full suite verification** — once all targeted tests pass, run the FULL test suite once to catch regressions:
   - If full suite passes → proceed to "All tests pass" above
   - If new failures appear → add them to the regression loop (iteration counter continues)

### Step 6: Post-Success

After all tests pass:

1. Update session state:
   ```
   - **Phase**: testing-complete
   ```
2. Suggest next step: "Tests are green. Use `commit-changes` when you're ready to commit."

## Standalone Usage

This skill works independently of the full pipeline. If the user says "run tests" without having run `start-feature` or `prime-project`:

- Infer the project from the current directory
- Read the project config directly
- Skip session state updates if no session state exists
- Still enforce all worktree safety rules
