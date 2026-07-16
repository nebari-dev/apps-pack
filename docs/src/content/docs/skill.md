---
title: Scaffolding skill
---

The **`new-nebari-app`** [Claude Code skill](https://docs.claude.com/en/docs/claude-code/skills)
teaches coding agents to generate apps in the exact layout this pack expects — real code plus
a `nebari-app.yaml` launch manifest — and to launch them through the
[MCP server](/mcp/). Together they make *"build me a dashboard, then launch it"* a single
conversation.

## Install

Copy the skill from the repository into your project (or user) skills directory:

```bash
# project-level
cp -r skill/new-nebari-app .claude/skills/

# or user-level
cp -r skill/new-nebari-app ~/.claude/skills/
```

It triggers on requests like *"create a nebari app"*, *"scaffold a static site for the
cluster"*, or *"launch it"* in a directory containing `nebari-app.yaml`.

## What it scaffolds

```
docs-site/
  nebari-app.yaml
  index.html
  styles.css
```

Static apps get real files (never hand-written inline YAML). The starter follows the
platform conventions: static assets served as-is, and **no auth code in the app** — the
gateway handles SSO.

## The manifest

`nebari-app.yaml` sits next to the code and maps 1:1 onto the [App resource](/app-crd-reference/):

```yaml
name: docs-site
namespace: apps
displayName: "Docs Site"
source:
  type: files
  files: { path: "." }
access:
  public: true
  subdomain: docs-site
```

Manifest source types are `files`, `git`, and `pvc`. `files` is an authoring convenience:
a directory path next to the manifest — on launch, the agent reads those files and passes
them as the app's `inline` source (same
rules as [uploads](/launching-apps/#uploading-files)). The full schema and the
manifest → `launch_app` mapping live in the skill's
[`references/manifest.md`](https://github.com/nebari-dev/nebari-apps-pack/blob/main/skill/new-nebari-app/references/manifest.md).

## "Launch it"

When the user asks, the agent:

1. reads `nebari-app.yaml`,
2. calls `describe_cluster` (and `authenticate` if prompted),
3. maps the manifest onto `launch_app` — idempotent, so iterating is safe,
4. polls `get_app_status` until `Running` (checking `get_app_logs` on failure),
5. reports the app URL.

The committed `nebari-app.yaml`
also doubles as the GitOps artifact for teams who keep their apps in version control.
