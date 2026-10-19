---
title: Getting started
---

## Prerequisites

- A Nebari cluster running the Nebari Infrastructure Core stack:
  [nebari-operator](https://github.com/nebari-dev/nebari-operator) `%NEBARI_OPERATOR_VERSION%` or
  later (provides the `NebariApp` CRD; the version this pack's contract test and dev loop
  pin), Envoy Gateway with the shared `public` (or `internal`) Gateway, and a Keycloak realm
  (`nebari` by default).
- cert-manager with a cluster issuer — only when TLS is enabled (the default).
- Helm 3.8+ and `kubectl` with cluster-admin for the install (the chart creates a CRD and
  ClusterRoles).
- Namespace opt-in: the nebari-operator only reconciles namespaces labeled
  `nebari.dev/managed=true` — label the release namespace and every namespace apps may be
  launched into.
- Sizing: the pack requests 300m CPU / 448Mi memory (limits 1.5 CPU / 896Mi) for its four
  pods, plus one pod per launched app sized by the App's `runtime.resources` (no default).
- Optional: metrics-server for per-app CPU/memory in the UI.

Read the [Known limitations](https://github.com/nebari-dev/apps-pack#known-limitations) before a
demo: group restrictions are not enforced by the gateway yet, and users manage only their
own apps (admins manage all of them).

## Install

Create the namespaces apps will run in first. The chart gives the API a `RoleBinding` in
each namespace in `api.allowedNamespaces` (default `apps`), so they must exist, and the
nebari-operator only processes namespaces that opt in:

```bash
kubectl create namespace apps
kubectl label namespace apps nebari.dev/managed=true
```

Then install:

```bash
# From a checkout: the chart's default image tags are its appVersion, which
# only matches images at a release commit. On main, use the images main builds.
helm install nebari-apps charts/nebari-apps \
  --namespace nebari-apps --create-namespace \
  --set clusterDomain=example.ai \
  --set keycloak.url=https://keycloak.example.ai/auth \
  --set operator.image.tag=latest --set api.image.tag=latest \
  --set ui.image.tag=latest --set mcp.image.tag=latest

# The nebari-operator only processes namespaces that opt in:
kubectl label namespace nebari-apps nebari.dev/managed=true
```

Or from the published chart with the ready-made values file
([`examples/nebari-values.yaml`](https://github.com/nebari-dev/apps-pack/blob/main/examples/nebari-values.yaml);
edit the two hostnames):

```bash
helm install nebari-apps oci://ghcr.io/nebari-dev/apps-pack/charts/nebari-apps \
  --namespace nebari-apps --create-namespace -f examples/nebari-values.yaml
```

With GitOps, apply the Argo CD `Application` in
[`examples/argocd-application.yaml`](https://github.com/nebari-dev/apps-pack/blob/main/examples/argocd-application.yaml) instead: it installs the same published chart
with the same values (edit the two hostnames and `targetRevision`).

```bash
kubectl apply -n argocd -f examples/argocd-application.yaml
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

The full reference, including every component's values and the `NebariApp` fields the chart
emits, is on the [Configuration](/configuration/) page.

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
| `apps.landingPage.enabled` | `false` | Cluster default for landing-page tiles of launched apps; apps override with `spec.landingPage.enabled`. |
| `ui.hostname` | `<appsDomain>` | Where the UI itself is served. |
| `ui.title`, `ui.branding.*` | — | Rebrand the UI (title, logos, favicon, theme, banners) — see [Branding](/branding/). |
| `ui.landingPage.*` | "Apps" tile | Landing-page tile label, description, category, icon, and health check — see [Branding](/branding/). |
| `gateway` | `public` | Shared Gateway apps attach to (`public` \| `internal`). |
| `staticImage` | `nginxinc/nginx-unprivileged:1.27-alpine` | Serves static app content. |
| `gitImage` | `alpine/git:v2.47.2` | Init-container image for git sources. |
| `pythonImage` | `ghcr.io/prefix-dev/pixi:0.68.1-noble` | Runs Python/pixi apps (`runtime.pixiTask`). |

## Launch your first app

> `apps` is the default entry in `api.allowedNamespaces` — to launch into other namespaces
> from the UI/API/MCP, add them to that list (or set it empty to allow every managed
> namespace). A namespace added to the list must exist before `helm upgrade`. `kubectl apply`
> is only gated by the namespace label.

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
