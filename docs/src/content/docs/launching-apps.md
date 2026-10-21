---
title: Launching apps
---

Every launch path produces the same `App` custom resource — the UI and API are conveniences
over one contract, so behavior is identical regardless of how an app was created.

This pack deploys three kinds of app:

- **Static sites** (HTML/CSS/JS) — served by nginx.
- **Python apps** — launched by a [pixi](https://pixi.sh) task (`runtime.pixiTask`); the
  platform runs `pixi install` then `pixi run <task>`, and the task must start a server
  on **0.0.0.0:$PORT** (`PORT` is injected: 8080, or 8081 when the app is
  [restricted to groups or users](#access-control)).
- **Container images** — a published image (Streamlit, Gradio, Shiny, Dash, a Node service)
  run as is, when the cluster allows its registry. See [Container images](#container-images).

## Sources

App **kind** (static vs Python) is independent of the **source** — any source can carry
either. An app with `runtime.pixiTask` set runs as a Python app; otherwise its content is
served statically.

| Source | Best for | How it runs |
|---|---|---|
| `inline` | small apps (text files, ~900KB) | Files carried in the `App` resource, mounted from a ConfigMap. |
| `git` | version-controlled apps | A non-root init container clones the repo at pod start. |
| `pvc` | larger apps, existing volumes | An existing PersistentVolumeClaim mounted (static) or copied into the workspace (Python). The claim must be labeled `apps.nebari.dev/mountable=true`. |
| `image` | apps that already ship as an image | The image runs as the app container. Only images from the cluster's allowed registries; never combined with `runtime.pixiTask`. |

## From the UI

Open `https://apps.<cluster-domain>`:

1. **Launch app** → name, display name, namespace, and **app type** (static site, Python
   app, or container image when the cluster allows one). For Python apps, enter the
   **launch task** — the pixi task that starts your server.
2. **Source** — **Upload** (a `.zip` of your app, or a single `.html` file for static
   sites), **Git**, or **Volume (PVC)**. A container image instead gets an **Image** card:
   the image with its tag or digest (the allowed registries are listed under it), the
   **port** it listens on, and optionally a command, arguments (one per line) and a user ID.
   An edit keeps the app's type: switch between an image and a source by relaunching.
3. **Runtime** — plain environment variables, which anyone who can see the app can read
   (the form says so: put credentials under Secrets). **Advanced** holds replicas, the Small/Medium/Large
   presets, CPU/memory requests and limits, **Keep running when idle** (`keepAlive`) and the
   **idle timeout** (see [Idle apps](#idle-apps)), and the port rule for Python apps; an edit
   opens it when the app already has non-default replicas, resources or idle settings.
4. **Secrets** — API keys, tokens, database URLs and other credentials, passed to the app
   as environment variables from its own Kubernetes Secret (see [Secrets](#secrets)). On an
   edit, saved secrets show their names only: leave a value empty to keep it, type to
   replace it, or remove the row.
5. **Access** — public toggle, allowed groups and users, and the subdomain, which follows
   the name (lowercased, other characters turned into hyphens) until you edit it. The
   landing-page option is locked off for now (see [Landing page](#landing-page)).
6. **Managers** — other users and groups who may manage the app with you (see
   [Managers](#managers)). Read-only when a manager edits the app.

The form checks each field when you leave it and lists every remaining problem, each
under its field, when you press **Launch app**; focus moves to the first one.

The Apps page tracks the rollout; the app's detail page shows its health (the App's
conditions), live pod logs, Kubernetes events and the App manifest as YAML, plus
stop/start/edit and a **More actions** menu with restart, copy URL and delete. When the app
is `Failed` or a condition is not ready, an alert under the header names the failing
condition and its reason, with **View logs** and **Restart**.

**Settings** (in the account menu, next to **Sign out**) is a read-only page in four
sections:

- **About** — the UI's and the API's version and build, links to these docs and the
  changelog, and **Report a bug**, which opens a GitHub issue with both versions filled in.
- **Your account** — your username, email and groups, and whether you are an admin. Your
  groups decide which restricted apps you can open (see [Access control](#access-control))
  and which apps you can manage (see [Managers](#managers)).
- **Cluster** — the apps domain, the namespaces you can launch into, the default idle
  timeout (see [Idle apps](#idle-apps)), the source types on offer, and the registries
  container images may come from (or that image apps are off).
- **Connect an agent** — this cluster's MCP server URL and a ready-to-paste
  `claude mcp add` command, each with a copy button (see [From an agent](#from-an-agent-mcp)).

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
  are injected. `PORT` is 8080, or 8081 when the authz sidecar takes 8080 (the app lists
  groups or users, or it can [idle](#idle-apps)), so read it rather than hard-coding a port. pixi task strings
  support `$PORT` but not `${PORT:-8080}`; run `PORT=8080 pixi run start` locally.
  Routing, TLS, and SSO are identical to static apps.
- First start resolves and downloads the environment, so cold starts take longer —
  commit a `pixi.lock` and the startup probe allows up to ten minutes.

See [`examples/python-inline-app.yaml`](https://github.com/nebari-dev/apps-pack/blob/main/examples/python-inline-app.yaml)
for a complete resource.

## Container images

Bring an image your CI already publishes; the cluster does not build images. A platform admin
first allows the registry (chart `apps.image.allowedRegistries`, see
[Image registries](/configuration/#image-registries)); until then the UI does not offer the
type and the API refuses it.

```yaml
apiVersion: apps.nebari.dev/v1alpha1
kind: App
metadata:
  name: sales-dash
  namespace: apps
spec:
  displayName: "Sales dashboard"
  source:
    type: image
    image:
      reference: ghcr.io/my-org/sales-dash:1.4.2   # or @sha256:<digest>
      port: 8501                                   # where the image's server listens
      args: ["--server.address=0.0.0.0"]           # optional; command replaces ENTRYPOINT
  runtime:
    secretKeys: [DATABASE_URL]
  access:
    groups: ["sales"]
    subdomain: sales-dash
```

What to know:

- **Tag or digest, from an allowed registry.** `ghcr.io/my-org` allows `ghcr.io/my-org/…`
  and nothing else (not `ghcr.io/my-org-other`); `docker.io/library` allows Docker Hub's
  official images such as `nginx:1.27`. The rules are in the
  [CRD reference](/app-crd-reference/#image-allowlist-matching). A tag is pulled again on
  every start; a digest pins the image.
- **The port.** Set `port` to where the server listens (on `0.0.0.0` or `127.0.0.1`), from
  1024 up and not 8080 or 8082: the pack's sidecar always sits in front of an image app on
  8080, enforcing `access.groups`/`access.users` and recording activity for
  [idling](#idle-apps). The port is also passed as `$PORT`.
- **Non-root.** The image must run as a non-root user, with no capabilities and no
  Kubernetes credentials. An image whose `USER` is root never starts: the app shows
  `Failed` with reason `ImageRunsAsRoot`. Rebuild it with a numeric non-root `USER` (e.g.
  `USER 1000`), or, if its `USER` is a name like `appuser`, set `runAsUser` to that user's
  uid. Many images also want a writable home or cache directory; point it at `/tmp` with an
  environment variable if the image's own directories belong to root.
- **Private registries** work when the admin sets `apps.image.pullSecrets`. A wrong reference
  or missing credentials show as `Failed` with reason `ImagePullFailed`.
- Secrets, environment variables, resources, replicas, access, managers and idling work as
  for every other app.

See [`examples/image-app.yaml`](https://github.com/nebari-dev/apps-pack/blob/main/examples/image-app.yaml)
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
[MCP server](/mcp/) page for connection and authentication details; the UI's **Settings**
page shows the server URL and the `claude mcp add` command for your cluster, ready to copy.

## Secrets

Most apps need a credential or two. Never put them in `runtime.env`: those values are part of
the App resource and come back to anyone who can read it, in `kubectl get app -o yaml`, the
API and MCP tool output (which coding agents often log). Set them as **secrets** instead:

- **UI** — the **Secrets** section of the launch and edit forms.
- **API** — `secrets` on `POST /apps` or `PATCH /apps/{ns}/{name}`, or
  `PATCH /apps/{ns}/{name}/secrets` (`{"OPENAI_API_KEY": "sk-…"}`; `null` removes a key). See
  [Secrets](/api-reference/#secrets).
- **MCP** — `secrets` on `launch_app` or in an `update_app` patch. Prefer the UI: values an
  agent passes stay in its transcript.
- **kubectl / GitOps** — create the Secret `app-<name>-secrets` yourself and list its keys in
  `spec.runtime.secretKeys` (see [Secrets](/app-crd-reference/#secrets)).

Each key reaches the app as an environment variable of the same name. Values are write-only:
the App lists only their names (`runtime.secretKeys`), and nothing (UI, API or MCP) shows a
value again. The Secret belongs to the App and is deleted with it, and only that app's pod
reads it. Setting a new value restarts the app's pods. The owner, managers and admins can
set, rotate and remove secrets.

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

## Managers

An App has one owner (`spec.owner`, whoever launched it), and can list other **managers** in
`spec.access.managers`: Keycloak usernames (`users`) and groups (`groups`). A manager can do
everything the owner can through the UI, the API and the MCP server: edit the app (its
[secrets](#secrets) included: they can set, rotate and remove values, never read them), stop,
start, wake, restart and delete it, and read its status, logs, events and metrics. The
app shows up in their Apps list and under **Mine**.

- **Only the owner and admins** (`api.adminGroups`) can change the manager list. A manager's
  edit may send the list unchanged or leave it out; changing it is refused with `403`.
- **Managing is not opening.** Managers of a restricted app still need to be in its
  `access.groups` or `access.users` to open it; add them there too if they should.
- Group membership comes from the caller's verified access token, so adding someone to a
  manager group applies when their token refreshes.
- Ownership itself cannot be transferred yet.

```yaml
spec:
  access:
    subdomain: team-dashboard
    managers:
      users: ["bob"]
      groups: ["data-team"]
```

The detail page shows who can manage the app (the owner, the managers, and admins) and
your own role.

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

## Idle apps

When the cluster sets `apps.idle.timeoutMinutes`, or an App sets
`runtime.idleTimeoutMinutes`, an App that goes that long without a request is scaled to zero
and shows as **Idle** in the Apps list, on its detail page and in `kubectl get apps`. Nothing is
lost: its URL still works. The first visit shows a "starting" page that reloads itself, and the
app is back once a pod is ready (seconds for a static app, longer for a Python app). Opening it
from the Apps list, **Wake** on its detail page, `start_app` over MCP or
`POST .../apps/{ns}/{name}/start` wake it too.

To keep an app always up (it must answer at once, or it works in the background without
visitors), turn on **Keep running when idle** in the form, or set `runtime.keepAlive: true`.
**Stop** is different from idle: a stopped app (`replicas: 0`) stays down until someone starts
it. See [Scale to zero](/app-crd-reference/#scale-to-zero) for how it works.

## Day-2 operations

| Action | UI | API | kubectl |
|---|---|---|---|
| Stop (scale to 0) | detail page → Stop | `POST .../apps/{ns}/{name}/stop` | set `spec.runtime.replicas: 0` |
| Start | detail page → Start | `POST .../apps/{ns}/{name}/start` | set `spec.runtime.replicas: 1` |
| Wake an idle app | open its URL, or detail page → Wake | `POST .../apps/{ns}/{name}/start` | open its URL, or annotate `apps.nebari.dev/wake-requested-at=<RFC 3339 now>` |
| Keep an app up | Edit → Advanced → Keep running when idle | `PATCH` `{"runtime": {"keepAlive": true}}` | set `spec.runtime.keepAlive: true` |
| Update | detail page → Edit | `PATCH .../apps/{ns}/{name}` | edit the CR |
| Restart (roll pods) | detail page → More actions → Restart | `POST .../apps/{ns}/{name}/restart` | `kubectl rollout restart deploy/app-<name>` |
| Logs | detail page → Logs | `GET .../apps/{ns}/{name}/logs` | `kubectl logs -l apps.nebari.dev/app=<name>` |
| Metrics | Detail page CPU/memory cards (while the app has pods); the Apps page's Needs attention banner and restart counts (restarts, `Failed`) | `GET .../apps/{ns}/{name}/metrics`, `GET /analytics/metrics` | `kubectl top pods -l apps.nebari.dev/app=<name>` |
| Delete | detail page → More actions → Delete (type to confirm) | `DELETE .../apps/{ns}/{name}` | `kubectl delete app <name>` |

Changing inline content rolls the pods automatically (the pod template carries a content
checksum), so an update is always a clean redeploy.
