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

It triggers on requests like *"create a nebari app"*, *"scaffold a streamlit app for the
cluster"*, or *"launch it"* in a directory containing `nebari-app.yaml`.

## What it scaffolds

```
docs-site/                    sales-dashboard/
  nebari-app.yaml               nebari-app.yaml
  index.html                    app.py             # framework starter
  styles.css                    pixi.toml          # local dev env (pixi run dev)
                                Dockerfile         # deployment image (port 8080, non-root)
                                README.md
```

Static apps get real files (never hand-written inline YAML); Python apps get a
framework starter, a `pixi.toml` for local development, and a Dockerfile for deployment.
Starter templates ship for static, Streamlit, and FastAPI; other frameworks adapt the
Streamlit template. All starters follow the platform conventions: listen on
`0.0.0.0:8080`, run as non-root, and **no auth code in the app** — the gateway handles SSO.

## The manifest

`nebari-app.yaml` sits next to the code and maps 1:1 onto the [App resource](/app-crd-reference/):

```yaml
name: sales-dashboard
namespace: apps
displayName: "Sales Dashboard"
framework: streamlit
source:
  type: image
  image: { repository: quay.io/org/sales-dashboard, tag: v1 }
access:
  public: false
  subdomain: sales-dashboard
```

One authoring convenience: static apps use `source.type: files` with a directory path —
on launch, the agent reads those files and passes them as the app's inline source (same
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

For Python apps the image must be built and pushed first (`docker build` / `docker push`
with the scaffolded Dockerfile) — the cluster pulls it. The committed `nebari-app.yaml`
also doubles as the GitOps artifact for teams who keep their apps in version control.
