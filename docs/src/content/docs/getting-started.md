---
title: Getting started
---

## Prerequisites

- A Nebari cluster with the [nebari-operator](https://github.com/nebari-dev/nebari-operator)
  installed (it provides the `NebariApp` CRD), Envoy Gateway, and a Keycloak realm.
- cert-manager with a cluster issuer — only when TLS is enabled (the default).
- Helm 3.8+.

## Install

```bash
helm install nebari-apps charts/nebari-apps \
  --namespace nebari-apps --create-namespace \
  --set clusterDomain=example.ai \
  --set keycloak.url=https://keycloak.example.ai/auth

# The nebari-operator only processes namespaces that opt in:
kubectl label namespace nebari-apps nebari.dev/managed=true
```

This deploys four components:

| Component | Where it ends up |
|---|---|
| **apps-operator** | Watches `App` resources cluster-wide. |
| **apps-api** | In-cluster Service; the UI proxies `/api` to it same-origin. |
| **apps-ui** | `https://apps.example.ai` — with a landing-page tile ("Apps"). |
| **apps-mcp** | `https://apps.example.ai/mcp` — agent tools, proxied by the UI (see [MCP server](/mcp/)). |

Every app launched afterwards gets `https://<subdomain>.apps.example.ai`.

## Key values

| Value | Default | Purpose |
|---|---|---|
| `clusterDomain` | — (required) | The cluster's base domain. |
| `appsDomain` | `apps.<clusterDomain>` | Domain apps are served under. |
| `tls.enabled` | `true` | Set `false` to serve plain HTTP (no certificates). |
| `keycloak.url` | — | Browser-facing Keycloak base URL (required when auth is on). |
| `keycloak.realm` | `nebari` | Keycloak realm. |
| `keycloak.internalUrl` | — | Optional in-cluster Keycloak URL (split horizon) for JWKS. |
| `api.auth.enabled` | `true` | Keycloak JWT auth for the API + keycloak-js login in the UI. |
| `api.allowedNamespaces` | `["apps"]` | Namespaces users may launch into via the API/UI/MCP. Empty list = every namespace labeled `nebari.dev/managed=true`. |
| `ui.hostname` | `<appsDomain>` | Where the UI itself is served. |
| `gateway` | `public` | Shared Gateway apps attach to (`public` \| `internal`). |
| `staticImage` | `nginxinc/nginx-unprivileged:1.27-alpine` | Serves static app content. |
| `gitImage` | `alpine/git:v2.47.2` | Init-container image for git sources. |
| `pythonImage` | `ghcr.io/prefix-dev/pixi:0.68.1-noble` | Runs Python/pixi apps (`runtime.pixiTask`). |

## Launch your first app

Namespaces that host apps must also opt in:

```bash
kubectl create namespace apps
kubectl label namespace apps nebari.dev/managed=true
```

> `apps` is the default entry in `api.allowedNamespaces` — to launch into other namespaces
> from the UI/API/MCP, add them to that list (or set it empty to allow every managed
> namespace). `kubectl apply` is only gated by the namespace label.

Then either open the UI at `https://apps.example.ai` and use the launch form, or apply a
sample `App`:

```bash
kubectl apply -n apps -f examples/static-inline-app.yaml   # or python-inline-app.yaml
kubectl get apps -n apps -w
```

```
NAME        SOURCE   PHASE     URL
docs-site   inline   Running   https://docs-site.apps.example.ai
```

When `PHASE` reaches `Running`, open the URL. Private apps redirect to Keycloak; public apps
(`access.public: true`) are reachable anonymously.

## Connect a coding agent

Point Claude Code (or any MCP client) at the cluster and launch with natural language:

```bash
claude mcp add --transport http nebari-apps https://apps.example.ai/mcp
```

The first tool call will ask you to log in via the Keycloak device flow (the agent shows a
verification URL and code). See the [MCP server guide](/mcp/) for the tool list and the
[scaffolding skill](/skill/) for generating apps the agent can launch.

## Verify a deployment

```bash
# The App's own status: phase, URL, replicas, conditions
kubectl describe app docs-site -n apps

# The children the operator created
kubectl get deploy,svc,cm,nebariapp -n apps

# Expected App conditions:
#   Validated: True         - spec is coherent, namespace opted in
#   WorkloadReady: True     - all replicas ready
#   RoutingReady: True      - the NebariApp reports Ready (routing/TLS/auth)
```

Deleting an `App` cascades: the Deployment, Service, ConfigMap, and `NebariApp` (and through
it the HTTPRoute, certificate, and OIDC client) are all garbage-collected.
