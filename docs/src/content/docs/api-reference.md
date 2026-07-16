---
title: REST API
---

The **apps-api** is the programmatic authority: every write renders an `App` custom
resource, and the operator does the actual work. The UI and the [MCP server](/mcp/) are
both thin clients over this API.

**Base path:** `/api/v1` — same-origin via the UI (`https://apps.<cluster-domain>/api/v1/...`).

## Authentication

All endpoints except `/healthz` and `/config` require a Keycloak **JWT bearer token**:

```
Authorization: Bearer <access-token>
```

The API validates the signature against the realm JWKS, and stamps the caller's
`preferred_username` as the app's `owner` on create. With `api.auth.enabled=false`
(local development), requests are anonymous.

## Endpoints

### Meta

| Method & path | Description |
|---|---|
| `GET /healthz` | Liveness (public). |
| `GET /config` | UI bootstrap config (public): `authEnabled`, Keycloak url/realm/SPA client id, `appsDomain`, `appsScheme`. |
| `GET /capabilities` | `{appsDomain, sourceTypes, namespaces}` — what this cluster supports and where the caller may launch. `sourceTypes` is `["git", "inline", "pvc"]`. |
| `GET /auth/me` | The caller's username, email, and groups. |

### Apps

| Method & path | Description |
|---|---|
| `GET /apps?namespace=` | List apps (all managed namespaces, or one). |
| `POST /apps` | Create + launch. Body mirrors `App.spec` plus `name`/`namespace` (see below). `409` if the name exists. |
| `POST /apps/upload` | Create + launch a static app from an upload. Multipart: `manifest` (JSON, source omitted) + `file` (`.zip` or `.html`). |
| `GET /apps/{ns}/{name}` | Full spec + status. |
| `PATCH /apps/{ns}/{name}` | Update any of `displayName`, `description`, `thumbnail`, `source`, `runtime`, `access`. |
| `DELETE /apps/{ns}/{name}` | Delete (cascades to all children). |
| `POST /apps/{ns}/{name}/stop` | Scale to zero. |
| `POST /apps/{ns}/{name}/start` | Scale back to one. |

### Observability

| Method & path | Description |
|---|---|
| `GET /apps/{ns}/{name}/status` | Phase, URL, replicas, conditions, message. |
| `GET /apps/{ns}/{name}/logs?lines=200&container=` | Recent pod logs. |
| `GET /apps/{ns}/{name}/events` | Kubernetes events for the app's resources. |
| `GET /analytics/summary?namespace=` | Totals and breakdowns by phase / source type / namespace, plus replica readiness. |

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

The API validates the source before writing the CR, so impossible launches fail fast with a
`422` and a human-readable `detail`.

## Upload request

`POST /apps/upload`, `multipart/form-data`:

| Part | Content |
|---|---|
| `manifest` | The create request JSON **without** `source`. |
| `file` | A `.zip` of the site, or a single `.html` file. |

Rules: archives need a root `index.html` (one top-level folder is flattened); text assets
only; ~900KB total. Violations return `400`/`413` with the reason. The extracted files
become the App's `inline` source.

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
| `403` | Namespace not available (not labeled `nebari.dev/managed=true`). |
| `404` | App (or its pods, for logs) not found. |
| `409` | An app with that name already exists in the namespace. |
| `413` | Upload exceeds the inline size cap. |
| `422` | Invalid request: unsupported source type, missing required fields. |

Error bodies are `{"detail": "..."}` with an actionable message.
