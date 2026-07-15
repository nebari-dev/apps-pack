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

This deploys three components:

| Component | Where it ends up |
|---|---|
| **apps-operator** | Watches `App` resources cluster-wide. |
| **apps-api** | In-cluster Service; the UI proxies `/api` to it same-origin. |
| **apps-ui** | `https://apps.example.ai` — with a landing-page tile ("Apps"). |

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
| `ui.hostname` | `<appsDomain>` | Where the UI itself is served. |
| `gateway` | `public` | Shared Gateway apps attach to (`public` \| `internal`). |
| `staticImage` | `nginxinc/nginx-unprivileged:1.27-alpine` | Serves static app content. |
| `gitImage` | `alpine/git:v2.47.2` | Init-container image for git sources. |

## Launch your first app

Namespaces that host apps must also opt in:

```bash
kubectl create namespace apps
kubectl label namespace apps nebari.dev/managed=true
```

Then either open the UI at `https://apps.example.ai` and use the launch form, or apply a
sample `App`:

```bash
kubectl apply -n apps -f examples/static-inline-app.yaml
kubectl get apps -n apps -w
```

```
NAME        FRAMEWORK   PHASE     URL
docs-site   static      Running   https://docs-site.apps.example.ai
```

When `PHASE` reaches `Running`, open the URL. Private apps redirect to Keycloak; public apps
(`access.public: true`) are reachable anonymously.

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
#   EnvironmentReady: True  - (static apps: not required)
```

Deleting an `App` cascades: the Deployment, Service, ConfigMap, and `NebariApp` (and through
it the HTTPRoute, certificate, and OIDC client) are all garbage-collected.
