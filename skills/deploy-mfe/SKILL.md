---
name: deploy-mfe
description: >
  Deploy a Micro-Frontend app to trunk, staging, dev (staging-2/staging-4), or production
  using GitHub Actions. Use when someone says "deploy <app> to trunk/staging/dev",
  "push <app> to trunk", "release <app>", or when debug-mfe recommends a redeploy.
---

# Deploy MFE

Trigger the correct GitHub Actions workflow to build and deploy an MFE app, then verify the deployment.

---

## Step 1: Resolve App and Environment

**Parse from user message.** If either is missing, ask for it.

**Apps (exact names used in workflows):**

- `adhoc-doc`, `aidp`, `benefit`, `employee-records`, `hiring`, `on-demand-interviews`
- `payroll`, `talent-network`, `time-off`, `onboarding-form-app`, `worker-survey`
- `knowledge-base`, `ws-mfe-parent`

**Environments:**
| User says | Canonical `ENV` |
|-----------|----------------|
| trunk | `trunk` |
| staging / staging-0 | `staging` |
| staging-2 / dev-2 | `staging-2` |
| staging-4 / dev-4 | `staging-4` |
| production / prod | `production` |

**Branch:** defaults to `master` unless user specifies one.

---

## Step 2: Map Environment to Workflow

| `ENV`        | Workflow file                  | Extra inputs                     |
| ------------ | ------------------------------ | -------------------------------- |
| `trunk`      | `deploy-mfe-to-trunk.yml`      | `app`, `branch`                  |
| `staging`    | `deploy-mfe-to-staging.yml`    | `app`, `branch`                  |
| `staging-2`  | `deploy-mfe-to-dev.yml`        | `app`, `env=staging-2`, `branch` |
| `staging-4`  | `deploy-mfe-to-dev.yml`        | `app`, `env=staging-4`, `branch` |
| `production` | `deploy-mfe-to-production.yml` | `app`, `branch`                  |

---

## Step 3: Trigger the Workflow

```bash
APP="<app>"
ENV="<env>"
BRANCH="${BRANCH:-master}"
REPO="helloworld1812/workstream-mono"

# Choose workflow file
case "$ENV" in
  trunk)      WORKFLOW="deploy-mfe-to-trunk.yml" ;;
  staging)    WORKFLOW="deploy-mfe-to-staging.yml" ;;
  staging-2)  WORKFLOW="deploy-mfe-to-dev.yml" ;;
  staging-4)  WORKFLOW="deploy-mfe-to-dev.yml" ;;
  production) WORKFLOW="deploy-mfe-to-production.yml" ;;
esac

# Build extra inputs
case "$ENV" in
  staging-2|staging-4)
    INPUTS="app=$APP,env=$ENV,branch=$BRANCH"
    ;;
  *)
    INPUTS="app=$APP,branch=$BRANCH"
    ;;
esac

gh workflow run "$WORKFLOW" \
  --repo "$REPO" \
  --field app="$APP" \
  --field branch="$BRANCH" \
  $([ "$ENV" = "staging-2" ] || [ "$ENV" = "staging-4" ] && echo "--field env=$ENV")

echo "Triggered $WORKFLOW for app=$APP env=$ENV branch=$BRANCH"
```

---

## Step 4: Find and Monitor the Run

Wait up to 30 seconds for the run to appear, then watch it:

```bash
sleep 10

# Find the most recent run for this workflow
RUN_ID=$(gh run list \
  --repo "$REPO" \
  --workflow "$WORKFLOW" \
  --limit 1 \
  --json databaseId \
  --jq '.[0].databaseId')

echo "Run ID: $RUN_ID"
echo "URL: https://github.com/$REPO/actions/runs/$RUN_ID"

# Watch progress (exits when run completes)
gh run watch "$RUN_ID" --repo "$REPO"

# Final status
gh run view "$RUN_ID" --repo "$REPO"
```

If the run fails, show the failing step logs:

```bash
gh run view "$RUN_ID" --repo "$REPO" --log-failed
```

---

## Step 5: Verify Deployment

Resolve the base URL for the environment:

| `ENV`        | Base URL                             |
| ------------ | ------------------------------------ |
| `trunk`      | `https://hr-trunk.workstream.is`     |
| `staging`    | `https://hr-staging.workstream.is`   |
| `staging-2`  | `https://hr-staging-2.workstream.is` |
| `staging-4`  | `https://hr-staging-4.workstream.is` |
| `production` | `https://hr.workstream.is`           |

Fetch version.json to confirm deployment:

```bash
VERSION_URL="${BASE_URL}/s/${APP}/version.json"
curl -s "$VERSION_URL" | node -e "
  const d = JSON.parse(require('fs').readFileSync('/dev/stdin', 'utf8'));
  console.log('app:', d.app);
  console.log('branch:', d.branch);
  console.log('commit:', d.commitShort);
  console.log('deployedAt:', d.deployedAt);
  console.log('deployedBy:', d.deployedBy);
"
```

If the commit matches the expected branch HEAD, deployment is confirmed.

---

## Step 6: Report

```
Deployed: <app> → <env>
Branch:   <branch>
Commit:   <short-sha>
By:       <actor>
At:       <deployedAt>
URL:      <BASE_URL>/<route>
```

If the run failed, report the error and do NOT mark deployment as verified.

---

## Production Guard

Before triggering production, confirm with the user:

```
⚠️  You are about to deploy <app> to PRODUCTION from branch <branch>.
    Type "yes" to confirm.
```

Wait for explicit confirmation before running Step 3.
