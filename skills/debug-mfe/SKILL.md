---
name: debug-mfe
description: >
  Diagnose and fix MFE (Micro-Frontend) issues — especially the "Oops! A new version
  of our app is available" ChunkLoadError that appears when app chunks are stale after
  a deployment. Use when someone reports a white screen, ChunkLoadError, version mismatch,
  or "can't access <app> on <env>".
---

# Debug MFE

Diagnose version mismatches and chunk-load failures in the MFE shell, then trigger the right redeployment to fix them.

---

## Background: Why ChunkLoadError Happens

The MFE shell (`ws-mfe-parent`) loads sub-apps dynamically via `single-spa`.
Each sub-app's entry point is `/s/<app>/index.html` on the same CDN host.

When a sub-app is **redeployed**, its JavaScript chunks get **new content hashes**.
If the old `index.html` (cached in the user's browser or on the CDN) references
the old chunk URLs, and those chunks no longer exist on S3, the browser throws a
`ChunkLoadError` — caught by `CatchAllErrorBoundary` and displayed as
**"Oops! A new version of our app is available"**.

Root causes:

1. **Sub-app stale**: `on-demand-interviews` (or another app) was redeployed but the CDN
   still serves old chunk files for the previous index.html.
2. **Parent stale**: `ws-mfe-parent` was redeployed with an updated sub-app entry reference,
   but the user is loading the old parent shell from browser cache.
3. **Both stale**: neither parent nor child matches — a full redeploy of both is needed.
4. **App never deployed to this env**: the sub-app has no build on this environment at all.

---

## Step 1: Resolve Environment and App

Parse from user message. Defaults:

- **env**: `trunk`
- **app**: the app the user mentioned, or ask if unclear

Environment → Base URL mapping:
| env | Base URL |
|-----|---------|
| `trunk` | `https://hr-trunk.workstream.is` |
| `staging` | `https://hr-staging.workstream.is` |
| `staging-2` | `https://hr-staging-2.workstream.is` |
| `staging-4` | `https://hr-staging-4.workstream.is` |
| `production` | `https://hr.workstream.is` |

---

## Step 2: Check Deployment Status

Fetch `version.json` for both the **affected sub-app** and **ws-mfe-parent** in parallel:

```bash
BASE_URL="<base-url>"
APP="<app>"

echo "=== $APP ==="
curl -sf "${BASE_URL}/s/${APP}/version.json" \
  | node -e "
    const d = JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));
    console.log('branch:', d.branch);
    console.log('commit:', d.commitShort);
    console.log('deployedAt:', d.deployedAt);
    console.log('buildNumber:', d.buildNumber);
  " || echo "ERROR: version.json not found (app may never have been deployed to this env)"

echo ""
echo "=== ws-mfe-parent ==="
curl -sf "${BASE_URL}/s/ws-mfe-parent/version.json" \
  | node -e "
    const d = JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));
    console.log('branch:', d.branch);
    console.log('commit:', d.commitShort);
    console.log('deployedAt:', d.deployedAt);
    console.log('buildNumber:', d.buildNumber);
  " || echo "ERROR: ws-mfe-parent version.json not found"
```

---

## Step 3: Verify Sub-App Entry Reachability

Check that the sub-app's `index.html` and at least one JS chunk are accessible:

```bash
echo "--- Checking $APP index.html ---"
HTTP_STATUS=$(curl -o /dev/null -sw "%{http_code}" "${BASE_URL}/s/${APP}/index.html")
echo "index.html HTTP status: $HTTP_STATUS"

if [ "$HTTP_STATUS" = "200" ]; then
  # Extract first JS chunk URL from index.html and test it
  CHUNK_URL=$(curl -sf "${BASE_URL}/s/${APP}/index.html" \
    | grep -oE 'src="[^"]+\.js"' \
    | head -1 \
    | grep -oE '"[^"]+"' \
    | tr -d '"')

  if [ -n "$CHUNK_URL" ]; then
    # Chunk URL may be relative or absolute
    if [[ "$CHUNK_URL" == http* ]]; then
      FULL_CHUNK_URL="$CHUNK_URL"
    else
      FULL_CHUNK_URL="${BASE_URL}${CHUNK_URL}"
    fi
    CHUNK_STATUS=$(curl -o /dev/null -sw "%{http_code}" "$FULL_CHUNK_URL")
    echo "First JS chunk HTTP status: $CHUNK_STATUS (${FULL_CHUNK_URL})"
  fi
fi
```

---

## Step 4: Check Recent GitHub Actions Runs

Check whether a deployment workflow ran recently for this app+env:

```bash
REPO="helloworld1812/workstream-mono"

# Map env to workflow
case "<env>" in
  trunk)      WORKFLOW="deploy-mfe-to-trunk.yml" ;;
  staging)    WORKFLOW="deploy-mfe-to-staging.yml" ;;
  staging-2|staging-4) WORKFLOW="deploy-mfe-to-dev.yml" ;;
  production) WORKFLOW="deploy-mfe-to-production.yml" ;;
esac

gh run list \
  --repo "$REPO" \
  --workflow "$WORKFLOW" \
  --limit 5 \
  --json displayTitle,conclusion,createdAt,url \
  --jq '.[] | "\(.createdAt) \(.conclusion) \(.displayTitle) \(.url)"'
```

---

## Step 5: Diagnose

Based on the evidence gathered, apply the decision table:

| Symptom                                | Root Cause                                  | Fix                                                     |
| -------------------------------------- | ------------------------------------------- | ------------------------------------------------------- |
| `version.json` 404 for sub-app         | App was never deployed to this env          | Redeploy sub-app                                        |
| `index.html` 200 but JS chunk 404      | Old index.html cached on CDN after redeploy | Redeploy sub-app (CloudFront invalidation will refresh) |
| Sub-app version much older than parent | Parent updated, sub-app stale               | Redeploy sub-app                                        |
| Parent version much older than sub-app | User's browser has old parent shell         | Redeploy `ws-mfe-parent` to push new CloudFront cache   |
| Both versions older than `master`      | Periodic deploy not run                     | Redeploy both                                           |
| Recent deploy workflow failed          | Build or deploy failure                     | Check run logs, fix, redeploy                           |

---

## Step 6: Fix

Report findings clearly, then trigger the fix:

```
Diagnosis: <one-sentence root cause>

Action: Redeploying <app(s)> to <env>
```

Invoke `deploy-mfe` for each app that needs redeployment.
If both sub-app and parent need redeploys, deploy sub-app first, then parent.

After both deploys complete, re-run Step 2 and Step 3 to confirm the fix:

```bash
# Confirm version.json is updated
curl -sf "${BASE_URL}/s/${APP}/version.json" | node -e "
  const d = JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));
  console.log('NEW commit:', d.commitShort, '| deployedAt:', d.deployedAt);
"

# Confirm index.html and first chunk are accessible
HTTP_STATUS=$(curl -o /dev/null -sw "%{http_code}" "${BASE_URL}/s/${APP}/index.html")
echo "index.html status after fix: $HTTP_STATUS"
```

---

## Step 7: Report

```
Environment:  <env>
Affected app: <app>

Root cause:   <one sentence>

Fix applied:
  ✅ Redeployed <app> — commit <sha>, deployed at <ts>
  ✅ Redeployed ws-mfe-parent — commit <sha>, deployed at <ts>  (if needed)

Verification:
  index.html: HTTP 200 ✅
  version.json commit: <sha> (matches master) ✅

QA can now refresh the page to pick up the latest version.
```

If the fix could not be verified, say so explicitly and provide the GitHub Actions run URL for manual inspection.
