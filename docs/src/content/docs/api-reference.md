---
title: REST API
---

The **apps-api** is the programmatic authority: every write renders an `App` custom
resource, and the operator does the actual work. The UI and the [MCP server](/mcp/) are
both thin clients over this API.

**Base path:** `/api/v1` — same-origin via the UI (`https://apps.<cluster-domain>/api/v1/...`).

## Authentication

All endpoints except `/healthz`, `/readyz`, `/version` and `/config` require a Keycloak **JWT bearer token**:

```
Authorization: Bearer <access-token>
```

The API validates the signature against the realm JWKS, and stamps the caller's
`preferred_username` as the app's `owner` on create. With `api.auth.enabled=false`
(local development), requests are anonymous and treated as an admin.

### Request ids

Every response carries an `X-Request-ID` header. Send one (up to 128 characters from
`A-Z a-z 0-9 . _ : -`) and it is kept; otherwise the API makes one. Behind the Nebari
gateway, Envoy assigns the id at the edge; the UI's nginx and the MCP server pass it on,
so the id on a response is the one in the API's logs for that call.

### Authorization

Every route that addresses one app (`/apps/{ns}/{name}` and everything under it) allows
only the app's **owner** or a member of an **admin group** (`api.adminGroups`, default
`["admin"]`); anyone else gets `403`. `GET /apps` and the `/analytics/*` endpoints return
only the apps the caller may see. Apps without an owner (created with `kubectl`) are
admin-only. The path namespace must be a launchable namespace on every route, not only on
create.

## Endpoints

### Meta

| Method & path | Description |
|---|---|
| `GET /healthz` | Liveness (public). Always `200` while the process serves. |
| `GET /readyz` | Readiness (public): `200 {"status": "ok", "checks": {...}}` when the Kubernetes API answers a namespace list and, with auth on, the realm JWKS loads (each within 3s; a good JWKS fetch is reused for 60s). Otherwise `503`, with the failing check marked `"failed"` and the reason in the API's log. |
| `GET /version` | Release and image build (public): `{"version": "0.2.0", "build": "sha-abc1234"}`. `build` is the chart's `api.image.tag` (`unknown` outside the chart). |
| `GET /config` | UI bootstrap config (public): `authEnabled`, Keycloak url/realm/SPA client id, `appsDomain`, `appsScheme`, and the `version`/`build` above. |
| `GET /capabilities` | `{appsDomain, sourceTypes, namespaces, idleTimeoutMinutes}` — what this cluster supports and where the caller may launch. `sourceTypes` is `["git", "inline", "pvc"]`; `idleTimeoutMinutes` is the cluster default for [scale to zero](/app-crd-reference/#scale-to-zero) (`0`: apps stay up unless they set one). |
| `GET /auth/me` | The caller's username, email, groups, and `admin` (member of an admin group). |

### Apps

| Method & path | Description |
|---|---|
| `GET /apps?namespace=` | List the apps the caller may see (all launchable namespaces, or one). |
| `POST /apps` | Create + launch. Body mirrors `App.spec` plus `name`/`namespace` (see below). `409` if the name exists in the namespace or the subdomain is used by any other app. |
| `POST /apps/upload` | Create + launch an app from an upload. Multipart: `manifest` (JSON, source omitted) + `file` (`.zip` or `.html`). A manifest with `runtime.pixiTask` launches the zip as a Python/pixi app. |
| `GET /apps/{ns}/{name}` | Full spec + status. |
| `PATCH /apps/{ns}/{name}` | Update any of `displayName`, `description`, `thumbnail`, `source`, `runtime`, `access`. `runtime` and `access` merge field by field: a field you send replaces the stored one (`null` or empty removes it), and fields you leave out keep their value, including ones set with `kubectl` such as `env[].valueFrom` or extra resource names. `source` is replaced whole. `access.subdomain` cannot change (`422`). |
| `DELETE /apps/{ns}/{name}` | Delete (cascades to all children). |
| `POST /apps/{ns}/{name}/stop` | Scale to zero. |
| `POST /apps/{ns}/{name}/start` | Scale a stopped app back to one replica, or wake an `Idle` one (it keeps its replicas; the operator starts it as if a request had arrived). |
| `POST /apps/{ns}/{name}/restart` | Roll the app's pods (like `kubectl rollout restart`) without changing the spec. `409` if the app is stopped. |

### Observability

| Method & path | Description |
|---|---|
| `GET /apps/{ns}/{name}/status` | Phase, URL, replicas, conditions, message. |
| `GET /apps/{ns}/{name}/logs?lines=200&container=` | Recent pod logs (`lines` 1–5000, default 200). |
| `GET /apps/{ns}/{name}/events` | Kubernetes events for the app's resources. |
| `GET /apps/{ns}/{name}/metrics` | Instantaneous per-pod CPU (millicores) and memory (Mi) from `metrics.k8s.io`. `{available, pods:[{name, cpu, memory}]}`; `available:false` when the cluster has no metrics server. |
| `GET /analytics/summary?namespace=` | Over the apps the caller may see: totals and breakdowns by phase / source type / namespace, plus replica readiness. |
| `GET /analytics/metrics` | Resource usage of the apps the caller may see, aggregated per app and per namespace, plus restart counts. `{usageAvailable, apps:[{namespace, name, cpu, memory, restarts}], byNamespace:[…]}`. Restart counts always populate (pod status); CPU/memory require a metrics server. |

## Create request

```json
{
  "name": "team-site",
  "namespace": "team-analytics",
  "displayName": "Team Site",
  "description": "The team's documentation site",
  "source": {
    "type": "git",
    "git": { "url": "https://github.com/org/site", "ref": "main", "subdir": "public" }
  },
  "runtime": {
    "replicas": 1,
    "env": [{ "name": "LOG_LEVEL", "value": "info" }],
    "resources": { "requests": { "cpu": "250m", "memory": "512Mi" } }
  },
  "access": { "public": false, "groups": ["analytics"], "subdomain": "team-site" }
}
```

To launch a **Python/pixi app**, add `"pixiTask": "<task>"` to `runtime` — the source
(any type) must then contain a `pixi.toml` or `pyproject.toml` at its root, and the task
must start a server on `0.0.0.0:$PORT` (8080, or 8081 when `access.groups` or
`access.users` is set or the app can idle). See [Launching apps](/launching-apps/#python-apps-pixi).

`name` must be a valid Kubernetes name — lowercase letters, digits, and hyphens
(`^[a-z0-9]([-a-z0-9]*[a-z0-9])?$`), at most 53 characters.

The API validates the source before writing the CR, so impossible launches fail fast with a
`422` and a human-readable `detail`.

## Upload request

`POST /apps/upload`, `multipart/form-data`:

| Part | Content |
|---|---|
| `manifest` | The create request JSON **without** `source`. |
| `file` | A `.zip` of the app, or a single `.html` file (static apps only). |

Rules: static archives need a root `index.html`; pixi archives (`runtime.pixiTask` in the
manifest) need a root `pixi.toml` or `pyproject.toml` instead (one top-level folder is
flattened either way). Text files only; ~900KB total. Violations return `400`/`413` with
the reason. The extracted files become the App's `inline` source.

```bash
curl -X POST https://apps.example.ai/api/v1/apps/upload \
  -H "Authorization: Bearer $TOKEN" \
  -F 'manifest={"name":"docs-site","namespace":"apps","displayName":"Docs Site",
                "access":{"public":true,"subdomain":"docs-site"}}' \
  -F "file=@site.zip"
```

## Errors

| Status | Meaning |
|---|---|
| `401` | Missing or invalid bearer token. |
| `403` | Namespace not available (not a launchable namespace), or the caller is neither the app's owner nor an admin. |
| `404` | App (or its pods, for logs) not found. |
| `409` | An app with that name already exists in the namespace, or the subdomain is already used by another app. |
| `413` | Request body over 2 MiB, or inline files over the ~900 KB inline cap (`MAX_UPLOAD_BYTES`), whether they come from an upload (or its extracted contents) or from `source.inline.files` in a JSON `POST`/`PATCH`. Zip members are checked against the cap before they are decompressed. |
| `422` | Invalid request: unsupported source type, missing required fields, or an `access.groups`/`access.users` entry that is blank or contains a comma. |

Error bodies are `{"detail": "..."}` with an actionable message.
