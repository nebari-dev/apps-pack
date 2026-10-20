---
title: Launching apps
---

Every launch path produces the same `App` custom resource — the UI and API are conveniences
over one contract, so behavior is identical regardless of how an app was created.

This pack deploys two kinds of app:

- **Static sites** (HTML/CSS/JS) — served by nginx.
- **Python apps** — launched by a [pixi](https://pixi.sh) task (`runtime.pixiTask`); the
  platform runs `pixi install` then `pixi run <task>`, and the task must start a server
  on **0.0.0.0:$PORT** (`PORT` is injected: 8080, or 8081 when the app is
  [restricted to groups or users](#access-control)).

## Sources

App **kind** (static vs Python) is independent of the **source** — any source can carry
either. An app with `runtime.pixiTask` set runs as a Python app; otherwise its content is
served statically.

| Source | Best for | How it runs |
|---|---|---|
| `inline` | small apps (text files, ~900KB) | Files carried in the `App` resource, mounted from a ConfigMap. |
| `git` | version-controlled apps | A non-root init container clones the repo at pod start. |
| `pvc` | larger apps, existing volumes | An existing PersistentVolumeClaim mounted (static) or copied into the workspace (Python). The claim must be labeled `apps.nebari.dev/mountable=true`. |

## From the UI

Open `https://apps.<cluster-domain>`:

1. **Launch app** → name, display name, namespace, and **app type** (static site or
   Python app). For Python apps, enter the **launch task** — the pixi task that starts
   your server.
2. **Source** — **Upload** (a `.zip` of your app, or a single `.html` file for static
   sites), **Git**, or **Volume (PVC)**.
3. **Runtime** — environment variables. **Advanced** holds replicas, the Small/Medium/Large
   presets, CPU/memory requests and limits, and the port rule for Python apps; an edit opens
   it when the app already has non-default replicas or resources.
4. **Access** — public toggle, allowed groups and users, and the subdomain, which follows
   the name (lowercased, other characters turned into hyphens) until you edit it. The
   landing-page option is locked off for now (see [Landing page](#landing-page)).

The form checks each field when you leave it and lists every remaining problem, each
under its field, when you press **Launch app**; focus moves to the first one.

The dashboard tracks the rollout; the app's detail page shows its health (the App's
conditions), live pod logs, Kubernetes events and the App manifest as YAML, plus
stop/start/edit and a **More actions** menu with restart, copy URL and delete. When the app
is `Failed` or a condition is not ready, an alert under the header names the failing
condition and its reason, with **View logs** and **Restart**.

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
start = "uvicorn app:app --host 0.0.0.0 --port $PORT"
```

The contract:

- `runtime.pixiTask` names the task to run (here `start`). The operator runs
  `pixi install` (with `--locked` when a `pixi.lock` is present) and then
  `pixi run <task>`.
- The task must start a server listening on **0.0.0.0:$PORT**; `PORT` and `HOME=/app`
  are injected. `PORT` is 8080, or 8081 when the app lists groups or users (the authz
  sidecar takes 8080), so read it rather than hard-coding a port. pixi task strings
  support `$PORT` but not `${PORT:-8080}`; run `PORT=8080 pixi run start` locally.
  Routing, TLS, and SSO are identical to static apps.
- First start resolves and downloads the environment, so cold starts take longer —
  commit a `pixi.lock` and the startup probe allows up to ten minutes.

See [`examples/python-inline-app.yaml`](https://github.com/nebari-dev/apps-pack/blob/main/examples/python-inline-app.yaml)
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
  are redirected to Keycloak and must sign in. The app itself never sees or handles auth.

- **Private with `access.groups` and/or `access.users`** — only those users get in: a
  member of **any** listed group **or** a listed username (`preferred_username`,
  case-insensitive). Everyone else who signs in gets **403**.

:::note[How groups and users are enforced]
The gateway's `SecurityPolicy` only signs users in
([nebari-operator#153](https://github.com/nebari-dev/nebari-operator/issues/153)), so the
pack enforces the lists in the app pod. For an App that lists groups or users, the
operator sets `forwardAccessToken: true` on its `NebariApp`, so the gateway passes the
user's Keycloak access token to the pod as `Authorization: Bearer …`, and adds the
**apps-authz** sidecar on port 8080 in front of the app container (which moves to 8081).
The sidecar verifies the token against the realm's keys (signature, expiry, issuer, and
that it was issued to the app's own client) and checks its `groups` and
`preferred_username` claims. A request with no token gets `401`; every other refusal is
`403`.

- **Group changes apply when the user's access token refreshes**: Keycloak's access-token
  lifespan, 5 minutes by default. Removing someone from a group does not end a session
  they already have open until then.
- Needs nebari-operator `%NEBARI_OPERATOR_VERSION%` or later (for `forwardAccessToken`) and the
  chart's `keycloak.url` or `keycloak.internalUrl`; without them the App fails validation
  instead of running open.
- `access.users` is not sent to the `NebariApp` (it has no per-user rule), so the
  landing page cannot hide a tile from users outside the list. That is why the launch
  form's landing-page switch is locked for now (see below).
- With the chart's `apps.networkPolicy.enabled`, only the gateway can reach the pod, and
  only on 8080. Static apps listen on loopback behind the sidecar; a Python task that
  binds `0.0.0.0` is reachable on 8081 from inside the cluster unless that policy is on.
:::

## Landing page

Launched apps are **not** shown on the Nebari landing page unless they opt in — the
landing page stays a curated list of platform services. Opt in per app with
`spec.landingPage.enabled: true` (`landing_page: true` in the MCP tool,
`landingPage.enabled` in `nebari-app.yaml`, the API, or `kubectl`); the
tile uses the app's `displayName`, `description` and `thumbnail`. An operator can flip the
cluster default with the chart value `apps.landingPage.enabled: true`, after which apps opt
*out* with `enabled: false`. Either way the app is reachable at its URL and listed in the
Apps UI.

The launch form's "Show on the landing page" option is **locked** for now: the landing
page can hide a tile only from users outside an app's groups, not outside its allowed
users, so the form registers new apps with `enabled: false` and an edit keeps whatever the
App already has. Register a tile through the API, the MCP tool or `kubectl` if you need
one.

## Day-2 operations

| Action | UI | API | kubectl |
|---|---|---|---|
| Stop (scale to 0) | detail page → Stop | `POST .../apps/{ns}/{name}/stop` | set `spec.runtime.replicas: 0` |
| Start | detail page → Start | `POST .../apps/{ns}/{name}/start` | set `spec.runtime.replicas: 1` |
| Update | detail page → Edit | `PATCH .../apps/{ns}/{name}` | edit the CR |
| Restart (roll pods) | detail page → More actions → Restart | `POST .../apps/{ns}/{name}/restart` | `kubectl rollout restart deploy/app-<name>` |
| Logs | detail page → Logs | `GET .../apps/{ns}/{name}/logs` | `kubectl logs -l apps.nebari.dev/app=<name>` |
| Metrics | Detail page CPU/memory cards (while the app has pods); the Dashboard's Needs attention card (restarts, `Failed`) | `GET .../apps/{ns}/{name}/metrics`, `GET /analytics/metrics` | `kubectl top pods -l apps.nebari.dev/app=<name>` |
| Delete | detail page → More actions → Delete (type to confirm) | `DELETE .../apps/{ns}/{name}` | `kubectl delete app <name>` |

Changing inline content rolls the pods automatically (the pod template carries a content
checksum), so an update is always a clean redeploy.
