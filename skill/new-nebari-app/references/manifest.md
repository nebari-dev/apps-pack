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
displayName: "Docs Site"
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
| `access.public` / `access.groups` | `public` / `groups` |
| `access.subdomain` | `subdomain` |

`files` constraints (they mirror the API's upload rules): must include `index.html` at the
root; text assets only (`.html .css .js .mjs .json .svg .txt .md .xml .csv .webmanifest .map`);
~900KB total. Skip hidden files and anything in `.gitignore`. Larger or binary-heavy sites:
use a `git` source.

## Serving model

Content is served by the platform's nginx (non-root, port 8080) behind the shared gateway.
The app directory needs no server code, Dockerfile, or build step — just the content files
and the manifest.
