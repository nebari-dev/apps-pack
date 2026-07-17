# nebari-app.yaml reference

The launch manifest committed next to an app's content. It maps 1:1 onto the Apps Pack's
`App` resource (`apps.nebari.dev/v1alpha1`) plus two authoring conveniences: `name`/
`namespace` live at the top level, and `source.type: files` references real files on disk
instead of inline YAML.

## Schema

```yaml
# Identity (top-level here; metadata on the App resource)
name: docs-site                # lowercase letters/digits/hyphens, max 53 chars
namespace: apps                # must be a namespace from describe_cluster

# Presentation
displayName: "Docs Site"                # required, max 64 chars
description: "Team documentation"       # optional, max 256 chars

source:
  type: files                  # files | git | pvc

  # --- type: files (authoring convenience) ---
  files:
    path: .                    # directory with index.html, relative to this manifest

  # --- type: git (content cloned at pod start) ---
  # git: { url: "https://github.com/org/site", ref: main, subdir: public }

  # --- type: pvc (content already on a volume) ---
  # pvc: { claimName: shared-docs, subPath: site }

runtime:                       # optional
  replicas: 1
  env:
    - name: LOG_LEVEL
      value: info
  resources:
    requests: { cpu: 250m, memory: 512Mi }
  # Python/pixi apps only: the pixi task that launches the app. When set, the
  # platform runs `pixi install` + `pixi run <task>` instead of serving the
  # source with nginx. The task must serve on 0.0.0.0:8080 (PORT is injected).
  pixiTask: start

access:
  public: false                # true = anonymous; false = Keycloak SSO at the gateway
  groups: ["analytics"]        # empty = any signed-in user
  subdomain: docs-site         # URL: http(s)://<subdomain>.<appsDomain>
```

## Manifest → MCP `launch_app` mapping

| Manifest | `launch_app` argument |
|---|---|
| `name` / `namespace` | `name` / `namespace` |
| `displayName` / `description` | `display_name` / `description` |
| `source.type: files` | `source_type: "inline"` + `inline_files: {relpath: content}` read from `files.path` |
| `source.type: git` | `source_type: "git"` + `git_url`, `git_ref`, `git_subdir` |
| `source.type: pvc` | `source_type: "pvc"` + `pvc_claim_name`, `pvc_sub_path` |
| `runtime.env` | `env` (as a `{NAME: value}` dict) |
| `runtime.replicas` | `replicas` |
| `runtime.pixiTask` | `pixi_task` |
| `access.public` / `access.groups` | `public` / `groups` |
| `access.subdomain` | `subdomain` |

The manifest covers everything `launch_app` accepts. The `App` resource has a few extra
fields with no manifest/tool equivalent (`spec.owner`, `spec.thumbnail`, `access.users`,
`runtime.keepAlive`) — set those via the API (`PATCH`) or `kubectl` after launch if needed.

`files` constraints (they mirror the API's upload rules): static apps must include
`index.html` at the root; pixi apps (`runtime.pixiTask` set) must include `pixi.toml` or
`pyproject.toml` at the root instead. Text files only
(`.html .css .js .mjs .json .svg .txt .md .xml .csv .webmanifest .map` plus
`.py .toml .lock .cfg .ini .yaml .yml .in .sh`); ~900KB total. Skip hidden files and
anything in `.gitignore`. Larger or binary-heavy apps: use a `git` source.

## Serving model

**Static apps** are served by the platform's nginx (non-root, port 8080) behind the shared
gateway. The app directory needs no server code, Dockerfile, or build step — just the
content files and the manifest.

**Python apps** (`runtime.pixiTask`) run in the platform's pixi image: the source is
copied into a writable workspace, `pixi install` resolves the environment (use a
committed `pixi.lock` for reproducible, faster starts), and `pixi run <task>` launches
the app. The task must start a server on **0.0.0.0:8080** — `PORT=8080` is injected, so
`--port ${PORT:-8080}` works both locally and on the cluster. No Dockerfile needed.
