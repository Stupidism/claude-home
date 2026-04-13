---
name: linear-template
description: Sync Linear issue templates from config/linear-templates.json to the Linear workspace. Run this whenever the template definitions change.
---

# Linear Template Sync

Syncs the issue templates defined in `$SYMPHONY_ROOT/config/linear-templates.json` to Linear using the API.

> **When to run:** After editing `linear-templates.json`, or to verify templates in Linear match the config.

---

## Step 1 — Read the template definitions

```bash
TEMPLATES_FILE="$HOME/.claude/symphony/config/linear-templates.json"
cat "$TEMPLATES_FILE"
```

Verify the file exists and contains valid JSON before proceeding.

---

## Step 2 — Sync each template to Linear

For each template in the JSON, call `templateUpdate` if it has an `id`, or `templateCreate` if not.

### Update an existing template

```bash
LINEAR_API_KEY="$(grep LINEAR_API_KEY ~/.claude/symphony/secrets.env | cut -d= -f2)"

TEMPLATE_ID="<id from JSON>"
TEMPLATE_NAME="<name>"
TEMPLATE_DESC="<description>"
TEMPLATE_DATA='<templateData JSON string>'   # the full templateData object, JSON-stringified

python3 - <<PYEOF
import json, urllib.request

api_key = "$(grep LINEAR_API_KEY ~/.claude/symphony/secrets.env | cut -d= -f2 | tr -d '\n')"
template_id = "$TEMPLATE_ID"
template_name = "$TEMPLATE_NAME"
template_desc = "$TEMPLATE_DESC"

# Build the templateData ProseMirror doc from markdown
# Read templateData from the JSON config for this template
import subprocess, os
config = json.loads(open(os.path.expanduser("~/.claude/symphony/config/linear-templates.json")).read())
tpl = next(t for t in config["templates"] if t["id"] == template_id)
template_data = json.dumps(tpl["templateData"])

mutation = """mutation {
  templateUpdate(id: "%s", input: {
    name: %s,
    description: %s,
    templateData: %s
  }) {
    success
    template { id name }
  }
}""" % (template_id, json.dumps(template_name), json.dumps(template_desc), json.dumps(template_data))

payload = json.dumps({"query": mutation}).encode()
req = urllib.request.Request(
    "https://api.linear.app/graphql",
    data=payload,
    headers={"Authorization": api_key, "Content-Type": "application/json"}
)
with urllib.request.urlopen(req) as resp:
    result = json.loads(resp.read())
    print(json.dumps(result, indent=2))
PYEOF
```

### Create a new template (when no `id` exists)

```bash
python3 - <<PYEOF
import json, urllib.request, os

api_key = "$(grep LINEAR_API_KEY ~/.claude/symphony/secrets.env | cut -d= -f2 | tr -d '\n')"
config = json.loads(open(os.path.expanduser("~/.claude/symphony/config/linear-templates.json")).read())
team_id = config["teamId"]

# Find templates without an id
for tpl in config["templates"]:
    if "id" in tpl:
        continue
    template_data = json.dumps(tpl["templateData"])
    mutation = """mutation {
      templateCreate(input: {
        teamId: "%s",
        name: %s,
        description: %s,
        type: issue,
        templateData: %s
      }) {
        success
        template { id name }
      }
    }""" % (team_id, json.dumps(tpl["name"]), json.dumps(tpl["description"]), json.dumps(template_data))

    payload = json.dumps({"query": mutation}).encode()
    req = urllib.request.Request(
        "https://api.linear.app/graphql",
        data=payload,
        headers={"Authorization": api_key, "Content-Type": "application/json"}
    )
    with urllib.request.urlopen(req) as resp:
        result = json.loads(resp.read())
        print(json.dumps(result, indent=2))
        # Save the returned id back to config
        new_id = result["data"]["templateCreate"]["template"]["id"]
        print(f"Created template '{tpl['name']}' with id: {new_id}")
        print("Update linear-templates.json with this id.")
PYEOF
```

---

## Step 3 — Verify

Check that the templates appear correctly in Linear:

1. Open Linear → Settings → Templates
2. Confirm Feature, Bug, and Chore templates match the descriptions in `linear-templates.json`

Or verify via API:

```bash
python3 - <<'PYEOF'
import json, urllib.request, os

api_key = open(os.path.expanduser("~/.claude/symphony/secrets.env")).read()
api_key = next(l.split("=",1)[1].strip() for l in api_key.splitlines() if l.startswith("LINEAR_API_KEY"))

query = '{ templates { id name description type } }'
payload = json.dumps({"query": query}).encode()
req = urllib.request.Request(
    "https://api.linear.app/graphql",
    data=payload,
    headers={"Authorization": api_key, "Content-Type": "application/json"}
)
with urllib.request.urlopen(req) as resp:
    result = json.loads(resp.read())
    for t in result["data"]["templates"]:
        print(t["id"], t["name"], f"({t['type']})")
PYEOF
```

---

## Template format reference

Templates are stored in `~/.claude/symphony/config/linear-templates.json`. The `descriptionMarkdown` field uses standard Markdown. Required sections per type:

| Section | Feature | Bug | Chore |
|---------|---------|-----|-------|
| Context | ✓ | ✓ | ✓ |
| Requirements | ✓ | — | ✓ |
| Steps to Reproduce | — | ✓ | — |
| Expected/Actual Behavior | — | ✓ | — |
| Acceptance Criteria | ✓ | ✓ | ✓ |
| Figma | ✓ (UI tickets) | — | — |
| Scope | ✓ | ✓ | ✓ |
| Environment | — | ✓ | — |
