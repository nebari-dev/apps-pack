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
cluster"*, *"scaffold a python app for nebari"*, or *"launch it"* in a directory
containing `nebari-app.yaml`.

## What it scaffolds

```
docs-site/                     py-app/
  nebari-app.yaml                nebari-app.yaml
  index.html                     pixi.toml
  styles.css                     app.py
```

Apps get real files (never hand-written inline YAML). The starters follow the platform
conventions: static assets served as-is, Python apps launched by a pixi task that serves
on `0.0.0.0:$PORT`, and **no auth code in the app** — the gateway handles SSO.

An app that already ships as a container image needs no scaffold: on a cluster that allows
image apps (`describe_cluster` lists `image`), the skill writes a manifest with
`source.type: image`, the image's reference and its port, and launches that. It never writes
a Dockerfile or builds an image.

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
[`references/manifest.md`](https://github.com/nebari-dev/apps-pack/blob/main/skill/new-nebari-app/references/manifest.md).

Credentials never go in the manifest: it is committed. The manifest lists only their names
in `runtime.secretKeys`, and the values are supplied out of band, by the user in the Apps
UI's **Secrets** section (preferred) or handed to the agent for `launch_app`'s `secrets`. See
[Secrets](/launching-apps/#secrets).

## "Launch it"

When the user asks, the agent:

1. reads `nebari-app.yaml`,
2. calls `describe_cluster` (if it reports an authentication problem, the user signs in to the server from `/mcp`),
3. maps the manifest onto `launch_app` — idempotent, so iterating is safe,
4. polls `get_app_status` until `Running` (checking `get_app_logs` on failure),
5. reports the app URL.

The MCP server's `launch_from_manifest` prompt encodes the same steps, so any MCP client can
follow them (and `triage_app` takes over when the launch fails); see [Prompts](/mcp/#prompts).

The committed `nebari-app.yaml`
also doubles as the GitOps artifact for teams who keep their apps in version control.
