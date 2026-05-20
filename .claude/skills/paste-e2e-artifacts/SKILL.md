---
name: paste-e2e-artifacts
description: Find Playwright E2E test screenshots and videos after tests run, upload them to the ticket system (Linear file upload API for Linear tickets, Jira issue attachment API for Jira tickets), and return markdown for embedding in the workpad as proof of work.
---

# Paste E2E Artifacts

After running Playwright E2E tests, find generated screenshots/videos and upload them to the ticket system so they can be embedded in or linked from the workpad as proof of work.

Route by `$TICKET_SYSTEM`:

- **Linear** → Linear's `fileUpload` GraphQL mutation, embed inline in the workpad as Linear CDN URLs.
- **Jira** → REST `POST /rest/api/3/issue/{key}/attachments`, then reference each attachment in the workpad by its `content` URL.

Any other value of `$TICKET_SYSTEM`: skip cleanly.

```bash
case "${TICKET_SYSTEM:-linear}" in
  linear|jira) ;;
  *) echo "paste-e2e-artifacts: unknown TICKET_SYSTEM=$TICKET_SYSTEM, skipping" >&2; exit 0 ;;
esac
```

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

## Step 2 — Upload Each Artifact

Route by `$TICKET_SYSTEM`.

### Linear path

For each artifact file, run this sequence.

#### 2a — Get a presigned upload URL from Linear

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

### Jira path

Jira accepts each file as a multipart upload to `POST /rest/api/3/issue/{key}/attachments`. The `X-Atlassian-Token: no-check` header is mandatory; the form field name must be `file`. Use the auth header / base URL defined in `$SKILLS_ROOT/jira/SKILL.md`.

```bash
JIRA_AUTH="Basic $(printf '%s:%s' "$JIRA_EMAIL" "$JIRA_API_TOKEN" | base64 | tr -d '\n')"
BOARD_FILE="$SYMPHONY_ROOT/config/boards/$(echo "$TICKET_ID" | cut -d- -f1 | tr A-Z a-z).json"
JIRA_BASE_URL=$(jq -r '.jira.baseUrl' "$BOARD_FILE")

for FILE_PATH in "${ARTIFACTS[@]}"; do
  curl -s -X POST \
    -H "Authorization: $JIRA_AUTH" \
    -H "X-Atlassian-Token: no-check" \
    -F "file=@${FILE_PATH}" \
    "$JIRA_BASE_URL/rest/api/3/issue/$TICKET_ID/attachments"
done
```

The response is a JSON array of attachment objects. For each one, save:

- `filename` — original file name
- `content` — direct URL to the binary (renders inline for images via Jira's CDN)
- `mimeType` — used to decide whether to embed (`image/*`) or link (`video/*`)

```bash
ATTACHMENTS_JSON=$(curl -s ... )  # response from the POST above

echo "$ATTACHMENTS_JSON" | node -e "
  const arr = JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));
  for (const a of arr) console.log(a.filename, a.mimeType, a.content);
"
```

## Step 3 — Build Proof of Work Markdown

After uploading all artifacts, build a markdown block:

```markdown
### E2E Proof of Work

| File | Preview |
|------|---------|
| screenshot-name.png | ![screenshot-name](<asset or attachment url>) |
| video-name.webm | [video-name.webm](<asset or attachment url>) |
```

For images (`.png`, `.jpg`): use `![filename](url)` — both Linear and Jira render inline.
For videos (`.webm`): use `[filename](url)` — neither system renders video inline.

The URL comes from Step 2:

- Linear → the `assetUrl` from the `fileUpload` mutation response (`https://uploads.linear.app/...`).
- Jira → the `content` field on the attachment object returned by the attachments POST (`<jira.baseUrl>/rest/api/3/attachment/content/<id>`).

## Step 4 — Append to Workpad

Append the proof of work block to the existing workpad body (do not replace the whole workpad). Route through the ticket dispatcher — read `$SKILLS_ROOT/ticket/SKILL.md` and use the matching sub-skill's "Update comment" intent:

1. Find the existing `## Claude Workpad` comment id (list comments via the dispatcher)
2. Read its current body
3. Insert the `### E2E Proof of Work` block before `### Notes`
4. Push the updated body back through the dispatcher

## Notes

- If the upload returns an error (Linear: `fileUpload` mutation; Jira: attachments POST — e.g. file too large), skip that file and log a warning.
- Videos are often large (>10 MB); if upload fails, log the local file path in the workpad instead.
- This skill is best-effort — if no artifacts exist or all uploads fail, continue to submit-for-review without blocking.
- Jira attachments are gated by issue-level browse permissions. If the ticket is private, attachment URLs won't be accessible to outsiders — same trust model as Jira inline images.
