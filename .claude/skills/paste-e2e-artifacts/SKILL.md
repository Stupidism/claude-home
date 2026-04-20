---
name: paste-e2e-artifacts
description: Find Playwright E2E test screenshots and videos after tests run, upload them to Linear via file upload API, and return markdown for embedding in the workpad as proof of work.
---

# Paste E2E Artifacts

After running Playwright E2E tests, find generated screenshots/videos and upload them to Linear so they can be embedded in the workpad as proof of work.

## Step 1 — Find Artifacts

Search for Playwright output in the worktree. Common locations (check all):

```bash
WORKTREE_ROOT=$(git rev-parse --show-toplevel)

# Find screenshots (.png, .jpg) and videos (.webm) from Playwright
find "$WORKTREE_ROOT" \
  \( -path "*/test-results/*" -o -path "*/playwright-report/*" -o -path "*/e2e/screenshots/*" \) \
  -not -path "*/node_modules/*" \
  \( -name "*.png" -o -name "*.jpg" -o -name "*.webm" \) \
  -newer "$WORKTREE_ROOT/package.json" \
  2>/dev/null | head -20
```

If no artifacts are found, skip this skill — no proof media to upload.

If artifacts are found, collect up to **5 most recently modified** files (prefer screenshots over videos; prefer failure screenshots over success):

```bash
find "$WORKTREE_ROOT" \
  \( -path "*/test-results/*" -o -path "*/playwright-report/*" -o -path "*/e2e/screenshots/*" \) \
  -not -path "*/node_modules/*" \
  \( -name "*.png" -o -name "*.jpg" -o -name "*.webm" \) \
  2>/dev/null \
  | xargs ls -t 2>/dev/null \
  | head -5
```

## Step 2 — Upload Each Artifact to Linear

For each artifact file, run this sequence:

### 2a — Get a presigned upload URL from Linear

```bash
FILE_PATH="/path/to/artifact.png"
FILENAME=$(basename "$FILE_PATH")
FILE_SIZE=$(wc -c < "$FILE_PATH" | tr -d ' ')

# Detect content type
case "${FILENAME##*.}" in
  png)  CONTENT_TYPE="image/png" ;;
  jpg|jpeg) CONTENT_TYPE="image/jpeg" ;;
  webm) CONTENT_TYPE="video/webm" ;;
  *)    CONTENT_TYPE="application/octet-stream" ;;
esac

UPLOAD_RESPONSE=$(curl -s -X POST https://api.linear.app/graphql \
  -H "Authorization: $LINEAR_API_KEY" \
  -H "Content-Type: application/json" \
  -d "{\"query\": \"mutation { fileUpload(contentType: \\\"${CONTENT_TYPE}\\\", filename: \\\"${FILENAME}\\\", size: ${FILE_SIZE}) { uploadUrl assetUrl headers { key value } } }\"}")

UPLOAD_URL=$(echo "$UPLOAD_RESPONSE" | node -e "process.stdout.write(JSON.parse(require('fs').readFileSync('/dev/stdin','utf8')).data.fileUpload.uploadUrl)")
ASSET_URL=$(echo "$UPLOAD_RESPONSE" | node -e "process.stdout.write(JSON.parse(require('fs').readFileSync('/dev/stdin','utf8')).data.fileUpload.assetUrl)")
CACHE_CONTROL=$(echo "$UPLOAD_RESPONSE" | node -e "const d=JSON.parse(require('fs').readFileSync('/dev/stdin','utf8')); const h=d.data.fileUpload.headers.find(h=>h.key==='Cache-Control'); process.stdout.write(h?.value??'')")
```

### 2b — Upload the file to the presigned URL

```bash
curl -s -X PUT "$UPLOAD_URL" \
  -H "Content-Type: $CONTENT_TYPE" \
  -H "Cache-Control: $CACHE_CONTROL" \
  --data-binary @"$FILE_PATH"
```

### 2c — Collect the asset URL

Save `$ASSET_URL` — this is the publicly accessible Linear CDN URL to embed in the workpad.

## Step 3 — Build Proof of Work Markdown

After uploading all artifacts, build a markdown block:

```markdown
### E2E Proof of Work

| File | Preview |
|------|---------|
| screenshot-name.png | ![screenshot-name](https://uploads.linear.app/...) |
| video-name.webm | [video-name.webm](https://uploads.linear.app/...) |
```

For images (`.png`, `.jpg`): use `![filename](url)` — Linear renders inline.
For videos (`.webm`): use `[filename](url)` — Linear does not render video inline.

## Step 4 — Append to Workpad

Append the proof of work block to the existing workpad body (do not replace the whole workpad):

1. Read the current workpad body (from the comment ID saved earlier)
2. Append the `### E2E Proof of Work` section before `### Notes`
3. Update the comment via `commentUpdate` (see `$SKILLS_ROOT/linear/SKILL.md`)

## Notes

- If the Linear `fileUpload` mutation returns an error (e.g. file too large), skip that file and log a warning.
- Videos are often large (>10 MB); if upload fails, log the local file path in the workpad instead.
- This skill is best-effort — if no artifacts exist or all uploads fail, continue to submit-for-review without blocking.
