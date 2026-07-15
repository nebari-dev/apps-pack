# nebari-app.yaml reference

The launch manifest committed next to an app's code. It maps 1:1 onto the Apps Pack's
`App` resource (`apps.nebari.dev/v1alpha1`) plus two authoring conveniences: `name`/
`namespace` live at the top level, and `source.type: files` references real files on disk
instead of inline YAML.

## Schema

```yaml
# Identity (top-level here; metadata on the App resource)
name: sales-dashboard          # lowercase letters/digits/hyphens, max 53 chars
namespace: apps                # must be a namespace from describe_cluster

# Presentation
displayName: "Sales Dashboard"
description: "Q2 sales explorer"        # optional, max 256 chars

# What runs
framework: streamlit           # static|streamlit|panel|gradio|dash|voila|fastapi|custom

source:
  type: files                  # files | image | git | pvc  (ociEnv planned)

  # --- type: files (static; authoring convenience) ---
  files:
    path: .                    # directory with index.html, relative to this manifest

  # --- type: image (Python/custom; prebuilt, pushed image on port 8080) ---
  # image:
  #   repository: quay.io/org/sales-dashboard
  #   tag: v1

  # --- type: git (static content cloned at pod start) ---
  # git: { url: "https://github.com/org/site", ref: main, subdir: public }

  # --- type: pvc (content already on a volume) ---
  # pvc: { claimName: shared-docs, subPath: site }

runtime:                       # optional
  replicas: 1
  command: []                  # required for framework: custom
  env:
    - name: LOG_LEVEL
      value: info
  resources:
    requests: { cpu: 250m, memory: 512Mi }

access:
  public: false                # true = anonymous; false = Keycloak SSO at the gateway
  groups: ["analytics"]        # empty = any signed-in user
  subdomain: sales-dashboard   # URL: http(s)://<subdomain>.<appsDomain>
```

## Manifest → MCP `launch_app` mapping

| Manifest | `launch_app` argument |
|---|---|
| `name` / `namespace` | `name` / `namespace` |
| `displayName` / `description` | `display_name` / `description` |
| `framework` | `framework` |
| `source.type: files` | `source_type: "inline"` + `inline_files: {relpath: content}` read from `files.path` |
| `source.type: image` | `source_type: "image"` + `image_repository`, `image_tag` |
| `source.type: git` | `source_type: "git"` + `git_url`, `git_ref`, `git_subdir` |
| `source.type: pvc` | `source_type: "pvc"` + `pvc_claim_name`, `pvc_sub_path` |
| `runtime.command` | `command` (list) |
| `runtime.env` | `env` (as a `{NAME: value}` dict) |
| `runtime.replicas` | `replicas` |
| `access.public` / `access.groups` | `public` / `groups` |
| `access.subdomain` | `subdomain` |

`files` constraints (they mirror the API's upload rules): must include `index.html` at the
root; text assets only (`.html .css .js .mjs .json .svg .txt .md .xml .csv .webmanifest .map`);
~900KB total. Skip hidden files and anything in `.gitignore`. Larger or binary-heavy sites:
use a `git` source.

## Framework table

Every app listens on **0.0.0.0:8080**. The operator injects framework env vars, so most
images need no flags.

| framework | Sources today | Serving process (inside your image) | Injected env |
|---|---|---|---|
| `static` | files, git, pvc | (nginx, provided by the platform) | — |
| `streamlit` | image | `streamlit run app.py` | `STREAMLIT_SERVER_PORT/ADDRESS/HEADLESS` |
| `panel` | image | `panel serve app.py --port 8080 --address 0.0.0.0 --allow-websocket-origin=*` | `PORT` |
| `gradio` | image | `python app.py` | `GRADIO_SERVER_PORT/NAME` |
| `dash` | image | `gunicorn app:server -b 0.0.0.0:8080` | `PORT` |
| `voila` | image | `voila app.ipynb --port=8080 --no-browser --Voila.ip=0.0.0.0` | `PORT` |
| `fastapi` | image | `uvicorn app:app --host 0.0.0.0 --port 8080` | `PORT` |
| `custom` | image | your `runtime.command` (required) | `PORT` |

`ociEnv` (running code inside a Nebi-published pixi environment, no image build) is in the
CRD contract but not launchable yet; keep `pixi.toml` current so switching is a two-line
manifest change when it lands.
