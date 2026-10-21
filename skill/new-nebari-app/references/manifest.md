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
  env:                         # plain values, visible to anyone who can read the app:
    - name: LOG_LEVEL          # never credentials
      value: info
  # Names of credentials the app reads from its environment. NAMES ONLY: the
  # values are supplied out of band (see "Secrets" below) and never committed.
  secretKeys: [OPENAI_API_KEY]
  resources:
    requests: { cpu: 250m, memory: 512Mi }
  # Python/pixi apps only: the pixi task that launches the app. When set, the
  # platform runs `pixi install` + `pixi run <task>` instead of serving the
  # source with nginx. The task must serve on 0.0.0.0:$PORT (PORT is injected:
  # 8080, or 8081 when groups or users are set or the app can idle).
  pixiTask: start
  # Scale to zero after this many minutes without a request (5-43200); the next
  # visit wakes it. Omit for the cluster default (often off).
  idleTimeoutMinutes: 60
  # true = never scale to zero (apps that must answer at once or work in the
  # background without visitors). Omit otherwise.
  keepAlive: false

access:
  public: false                # true = anonymous; false = Keycloak SSO at the gateway
  groups: ["analytics"]        # allowed groups (enforced in the app pod; 403 for others)
  users: ["alice"]             # allowed usernames, in addition to the groups
  managers:                    # optional: who else may manage (edit, stop, delete) the app;
    users: ["bob"]             # not who may open it. Only the owner or an admin can change it
    groups: ["data-team"]
  subdomain: docs-site         # URL: http(s)://<subdomain>.<appsDomain>

landingPage:                   # optional
  enabled: true                # tile on the Nebari landing page; omit = cluster default (off).
                               # The tile honors groups only: users-only apps show it to everyone
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
| `runtime.secretKeys` | none directly: names the keys the user must supply; see [Secrets](#secrets) (`secrets` takes `{NAME: value}`) |
| `runtime.replicas` | `replicas` (0–10) |
| `runtime.resources` | `resources` (same `{requests, limits}` shape; omitted values get the cluster default) |
| `runtime.pixiTask` | `pixi_task` |
| `runtime.keepAlive` | `keep_alive` |
| `runtime.idleTimeoutMinutes` | `idle_timeout_minutes` (omit when the manifest omits it) |
| `access.public` / `access.groups` / `access.users` | `public` / `groups` / `users` |
| `access.managers.users` / `access.managers.groups` | `manager_users` / `manager_groups` (omit both when the manifest has no `managers`, so a re-launch keeps the current list) |
| `access.subdomain` | `subdomain` |
| `landingPage.enabled` | `landing_page` (omit when the manifest omits it) |

The manifest covers everything `launch_app` accepts. The `App` resource has a few extra
fields with no manifest/tool equivalent (`spec.owner`, `spec.thumbnail`) — set those via the
API (`PATCH`) or `kubectl` after launch if needed.

`files` constraints (they mirror the API's upload rules): static apps must include
`index.html` at the root; pixi apps (`runtime.pixiTask` set) must include `pixi.toml` or
`pyproject.toml` at the root instead. Text files only
(`.html .css .js .mjs .json .svg .txt .md .xml .csv .webmanifest .map` plus
`.py .toml .lock .cfg .ini .yaml .yml .in .sh`); ~900KB total. Skip hidden files and
anything in `.gitignore`. Larger or binary-heavy apps: use a `git` source.

## Secrets

Credentials (API keys, tokens, database URLs, passwords) **never** go in `nebari-app.yaml`,
in `runtime.env`, or in any committed file (`.env` included): the manifest is a version-
controlled GitOps artifact, and `env` values are stored in the `App` and returned to anyone
who can read it. The manifest lists only the **names** in `runtime.secretKeys`; the values
are supplied out of band and stored write-only in the app's own Kubernetes Secret
(`app-<name>-secrets`, deleted with the app, readable only by its pod):

1. **Preferred:** after `launch_app`, ask the user to open the app in the Apps UI → **Edit**
   → **Secrets** and enter each value. The values never pass through the agent.
2. If the user hands you a value in the conversation and asks you to set it, pass it as
   `secrets: {NAME: value}` to `launch_app` or in an `update_app` patch, and say that it is
   now in the conversation transcript. Never read values from files on your own initiative.
3. GitOps: create the Secret with `kubectl create secret generic app-<name>-secrets ...`
   (or Sealed Secrets / External Secrets) and keep `secretKeys` in the rendered App.

Each key reaches the app as an environment variable of the same name (names must match
`^[A-Za-z_][A-Za-z0-9_]*$`). No tool ever returns a value: `get_app` shows the names that
are set in `runtime.secretKeys`, which is how to check that every name the manifest lists
has been supplied. Until it has, the app does not start; do not report it as broken. Setting
a value restarts the app.

## Serving model

**Static apps** are served by the platform's nginx (non-root, port 8080) behind the shared
gateway. The app directory needs no server code, Dockerfile, or build step — just the
content files and the manifest.

**Python apps** (`runtime.pixiTask`) run in the platform's pixi image: the source is
copied into a writable workspace, `pixi install` resolves the environment (use a
committed `pixi.lock` for reproducible, faster starts), and `pixi run <task>` launches
the app. The task must start a server on **0.0.0.0:$PORT** — `PORT` is injected (8080, or
8081 when `access.groups`/`access.users` or idling puts the authz sidecar on 8080), so use
`--port $PORT` and run `PORT=8080 pixi run start` locally (pixi tasks do not support
`${PORT:-8080}`). No Dockerfile needed.

**Idle apps.** When the cluster (or the manifest's `runtime.idleTimeoutMinutes`) sets an
idle timeout, an app with no requests for that long is scaled to zero (phase `Idle`). Its
URL keeps working: the first visit shows a "starting" page until the app is back, which
takes seconds for a static app and longer for a Python app. `get_app_status` reporting
`Idle` is normal, not a failure; `start_app` wakes it. Set `runtime.keepAlive: true` for
apps that must always be up.
