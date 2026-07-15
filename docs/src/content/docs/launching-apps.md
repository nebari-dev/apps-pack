---
title: Launching apps
---

Every launch path produces the same `App` custom resource — the UI and API are conveniences
over one contract, so behavior is identical regardless of how an app was created.

## Frameworks and sources

| Framework | Available sources | How it runs |
|---|---|---|
| `static` | `inline`, `git`, `pvc` | nginx (unprivileged) serving the content root on 8080. |
| `streamlit`, `panel`, `gradio`, `dash`, `voila`, `fastapi` | `image` (`ociEnv` planned) | Your prebuilt image, listening on port 8080. |
| `custom` | `image` | Any container on port 8080; `runtime.command` is required. |

Python frameworks get framework-appropriate environment variables injected (e.g.
`STREAMLIT_SERVER_PORT=8080`, `GRADIO_SERVER_PORT=8080`, or a generic `PORT=8080`) and TCP
readiness probes, so most images work unmodified as long as they bind `0.0.0.0:8080`.

## From the UI

Open `https://apps.<cluster-domain>`:

1. **Launch app** → name, display name, namespace, and framework.
2. **Source** — static apps offer **Upload** (a `.zip` of your site or a single `.html`
   file) and **Git**; Python frameworks take an image repository/tag with an optional
   command override.
3. **Runtime** — replicas, CPU/memory requests, environment variables.
4. **Access** — public toggle, allowed groups, and the subdomain.

The dashboard tracks the rollout; the app's detail page shows conditions, live pod logs,
and Kubernetes events, plus stop/start/delete.

## Uploading files

Uploads accept a **zip archive** or a **single `.html` file**:

- Archives need an `index.html` at their root (a single top-level folder is flattened).
- Text assets only (`.html`, `.css`, `.js`, `.json`, `.svg`, …) up to ~900KB total — the
  files are carried inline in the `App` resource and materialized as a ConfigMap-backed
  volume. Bigger sites or binary assets should use a `git` or `pvc` source.

Via the API:

```bash
curl -X POST https://apps.example.ai/api/v1/apps/upload \
  -H "Authorization: Bearer $TOKEN" \
  -F 'manifest={"name":"docs-site","namespace":"apps","displayName":"Docs Site",
                "access":{"public":true,"subdomain":"docs-site"}}' \
  -F "file=@site.zip"
```

## From the API

```bash
curl -X POST https://apps.example.ai/api/v1/apps \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{
    "name": "sales-dashboard",
    "namespace": "team-analytics",
    "displayName": "Sales Dashboard",
    "framework": "streamlit",
    "source": {"type": "image", "image": {"repository": "quay.io/org/sales-dashboard", "tag": "v1"}},
    "runtime": {"replicas": 1, "env": [{"name": "LOG_LEVEL", "value": "info"}]},
    "access": {"public": false, "groups": ["analytics"], "subdomain": "sales-dashboard"}
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
  framework: static
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
| Update | — (planned) | `PATCH .../apps/{ns}/{name}` | edit the CR |
| Logs | detail page → Logs | `GET .../apps/{ns}/{name}/logs` | `kubectl logs -l apps.nebari.dev/app=<name>` |
| Delete | detail page → Delete | `DELETE .../apps/{ns}/{name}` | `kubectl delete app <name>` |

Changing inline content rolls the pods automatically (the pod template carries a content
checksum), so an update is always a clean redeploy.
