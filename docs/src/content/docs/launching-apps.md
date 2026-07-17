---
title: Launching apps
---

Every launch path produces the same `App` custom resource — the UI and API are conveniences
over one contract, so behavior is identical regardless of how an app was created.

This pack deploys two kinds of app:

- **Static sites** (HTML/CSS/JS) — served by nginx.
- **Python apps** — launched by a [pixi](https://pixi.sh) task (`runtime.pixiTask`); the
  platform runs `pixi install` then `pixi run <task>`, and the task must start a server
  on **0.0.0.0:8080** (`PORT=8080` is injected).

## Sources

App **kind** (static vs Python) is independent of the **source** — any source can carry
either. An app with `runtime.pixiTask` set runs as a Python app; otherwise its content is
served statically.

| Source | Best for | How it runs |
|---|---|---|
| `inline` | small apps (text files, ~900KB) | Files carried in the `App` resource, mounted from a ConfigMap. |
| `git` | version-controlled apps | A non-root init container clones the repo at pod start. |
| `pvc` | larger apps, existing volumes | An existing PersistentVolumeClaim mounted (static) or copied into the workspace (Python). |

## From the UI

Open `https://apps.<cluster-domain>`:

1. **Launch app** → name, display name, namespace, and **app type** (static site or
   Python app). For Python apps, enter the **launch task** — the pixi task that starts
   your server.
2. **Source** — **Upload** (a `.zip` of your app, or a single `.html` file for static
   sites), **Git**, or **PVC**.
3. **Runtime** — replicas, CPU/memory requests, environment variables.
4. **Access** — public toggle, allowed groups, and the subdomain.

The dashboard tracks the rollout; the app's detail page shows conditions, live pod logs,
and Kubernetes events, plus stop/start/delete.

## Uploading files

Uploads accept a **zip archive** or a **single `.html` file**:

- Static archives need an `index.html` at their root; Python apps (manifest has
  `runtime.pixiTask`) need a `pixi.toml` or `pyproject.toml` instead. A single top-level
  folder is flattened.
- Text files only (`.html`, `.css`, `.js`, `.json`, `.svg`, `.py`, `.toml`, `.lock`, …)
  up to ~900KB total — the files are carried inline in the `App` resource and
  materialized as a ConfigMap-backed volume. Bigger apps or binary assets should use a
  `git` or `pvc` source.

Via the API:

```bash
curl -X POST https://apps.example.ai/api/v1/apps/upload \
  -H "Authorization: Bearer $TOKEN" \
  -F 'manifest={"name":"docs-site","namespace":"apps","displayName":"Docs Site",
                "access":{"public":true,"subdomain":"docs-site"}}' \
  -F "file=@site.zip"
```

A Python app is the same call with `runtime.pixiTask` in the manifest and a zip
containing at least a `pixi.toml` and your Python source:

```bash
curl -X POST https://apps.example.ai/api/v1/apps/upload \
  -H "Authorization: Bearer $TOKEN" \
  -F 'manifest={"name":"py-app","namespace":"apps","displayName":"Py App",
                "runtime":{"pixiTask":"start"},
                "access":{"public":true,"subdomain":"py-app"}}' \
  -F "file=@app.zip"
```

## Python apps (pixi)

The zip (or git repo / PVC) is a normal pixi project — at minimum a `pixi.toml` and a
`.py` entrypoint, plus any packages and directories you need:

```
app.zip
├── pixi.toml        # defines dependencies and tasks
├── pixi.lock        # recommended: reproducible, faster installs
├── app.py
└── pkg/
    └── util.py
```

```toml
[tasks]
start = "uvicorn app:app --host 0.0.0.0 --port ${PORT:-8080}"
```

The contract:

- `runtime.pixiTask` names the task to run (here `start`). The operator runs
  `pixi install` (with `--locked` when a `pixi.lock` is present) and then
  `pixi run <task>`.
- The task must start a server listening on **0.0.0.0:8080**; `PORT=8080` and
  `HOME=/app` are injected. Routing, TLS, and SSO are identical to static apps.
- First start resolves and downloads the environment, so cold starts take longer —
  commit a `pixi.lock` and the startup probe allows up to ten minutes.

See [`examples/python-inline-app.yaml`](https://github.com/nebari-dev/nebari-apps-pack/blob/main/examples/python-inline-app.yaml)
for a complete resource.

## From the API

```bash
curl -X POST https://apps.example.ai/api/v1/apps \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{
    "name": "team-site",
    "namespace": "apps",
    "displayName": "Team Site",
    "source": {"type": "git", "git": {"url": "https://github.com/org/site", "ref": "main", "subdir": "public"}},
    "runtime": {"replicas": 1, "env": [{"name": "LOG_LEVEL", "value": "info"}]},
    "access": {"public": false, "groups": ["analysts"], "subdomain": "team-site"}
  }'
```

See the [REST API reference](/api-reference/) for the full surface.

## From kubectl

Write the `App` resource directly — useful for GitOps:

```yaml
apiVersion: apps.nebari.dev/v1alpha1
kind: App
metadata:
  name: team-site
  namespace: apps
spec:
  displayName: "Team Site"
  source:
    type: git
    git:
      url: https://github.com/org/site
      ref: main
      subdir: public
  access:
    public: false
    groups: ["analysts"]
    subdomain: team-site
```

The namespace must carry the `nebari.dev/managed=true` label. See the
[App CRD reference](/app-crd-reference/) for every field.

## From an agent (MCP)

Coding agents (Claude Code, Codex, or any MCP client) can launch and manage apps with
natural language through the **apps-mcp** server — `launch_app` is idempotent on
(namespace, name), so re-launching updates instead of failing. See the
[MCP server](/mcp/) page for connection and authentication details.

## Access control

- **`access.public: true`** — no authentication; anyone with the URL.
- **Private (default)** — the app's `NebariApp` creates a gateway `SecurityPolicy`: users
  are redirected to Keycloak, and only `access.groups` members are authorized (empty
  groups = any signed-in user). The app itself never sees or handles auth.

## Day-2 operations

| Action | UI | API | kubectl |
|---|---|---|---|
| Stop (scale to 0) | detail page → Stop | `POST .../apps/{ns}/{name}/stop` | set `spec.runtime.replicas: 0` |
| Start | detail page → Start | `POST .../apps/{ns}/{name}/start` | set `spec.runtime.replicas: 1` |
| Update | detail page → Edit | `PATCH .../apps/{ns}/{name}` | edit the CR |
| Restart (roll pods) | detail page → Restart | `POST .../apps/{ns}/{name}/restart` | `kubectl rollout restart deploy/app-<name>` |
| Logs | detail page → Logs | `GET .../apps/{ns}/{name}/logs` | `kubectl logs -l apps.nebari.dev/app=<name>` |
| Metrics | Metrics page / detail cards | `GET .../apps/{ns}/{name}/metrics`, `GET /analytics/metrics` | `kubectl top pods -l apps.nebari.dev/app=<name>` |
| Delete | detail page → Delete (type to confirm) | `DELETE .../apps/{ns}/{name}` | `kubectl delete app <name>` |

Changing inline content rolls the pods automatically (the pod template carries a content
checksum), so an update is always a clean redeploy.
