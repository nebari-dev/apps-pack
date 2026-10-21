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
  pods. Each launched app adds a pod; an App that sets no `runtime.resources` gets the chart
  defaults (`apps.defaultResources`: 50m / 64Mi requested, up to 500m / 256Mi, for a static
  site; 250m / 512Mi requested, up to 2 CPU / 2Gi, for a Python app, whose cold
  `pixi install` needs the memory).
- Optional: metrics-server for per-app live CPU/memory usage in the UI (without it the UI
  still shows limits and restarts) and the LGTM observability pack for logs.

Read the [Known limitations](#known-limitations) before a demo: group and user restrictions
are enforced in the app pod (by a sidecar), not at the gateway, and users manage only their
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
  --set ui.image.tag=latest --set mcp.image.tag=latest \
  --set authz.image.tag=latest

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

This deploys four components. A fifth image, **apps-authz**, is not a Deployment: the
operator adds it as a sidecar to Apps that list `access.groups`, that can idle, or that run an image.

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
claude mcp add --transport http --client-id nebari-apps-mcp --callback-port 33418 \
  nebari-apps https://apps.example.ai/mcp
```

The client id is the Keycloak client your admin created for MCP sign-in (`mcp.oauth.clientId`;
the UI's Settings page shows the exact command). Run `/mcp` in Claude Code, select
`nebari-apps` and choose **Authenticate** to sign in through the browser. See the
[MCP server guide](/mcp/) for the tool list and the
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

## Known limitations

The pack is alpha: the happy path works, and these are the gaps to know about before a demo
or pilot.

- **`access.groups` is enforced in the app pod, not at the gateway.** The
  nebari-operator `SecurityPolicy` only signs users in
  ([nebari-operator#153](https://github.com/nebari-dev/nebari-operator/issues/153)), so a
  private app that lists groups gets the apps-authz sidecar, which checks the
  forwarded access token and returns `403` to everyone else. Group changes apply when the
  user's token refreshes (5 minutes by default). A private app with no groups is open to any
  signed-in realm user. Access is by group only; there is no per-user allow list. See
  [Access control](/launching-apps/#access-control).
- **Authorization is owner, manager or admin.** The API lets a user see and manage the Apps
  they launched or are listed as a [manager](/launching-apps/#managers) of; members of
  `api.adminGroups` manage all of them. Ownership cannot be transferred yet, and anyone with
  `kubectl` access to an app namespace bypasses the API.
- **App secrets are environment variables only.** Credentials set as
  [secrets](/launching-apps/#secrets) reach the app as env vars from its own Secret; there is
  no mounted-file form yet, and no external secret store integration (Vault, External Secrets
  Operator can still create an app's `app-<name>-secrets`). A Secret edited with `kubectl`
  reaches running pods only after a rollout restart. The API's ServiceAccount can create and
  patch Secrets (never read them) in app namespaces, cluster-wide when
  `api.allowedNamespaces` is empty.
- **Inline sources are capped at ~900 KB of UTF-8 text** (a ConfigMap). Binary assets or
  larger sites need a `git` or `pvc` source.
- **No per-user quota.** Launched pods get default requests/limits and at most 10 replicas
  each, but nothing caps how many Apps one user launches. Add a `ResourceQuota` to app
  namespaces if that matters (the chart can render a `LimitRange` and a `NetworkPolicy`:
  `apps.limitRange` / `apps.networkPolicy`).
- **Scale to zero is off by default and has cold starts.** Idle Apps are scaled to zero only
  when `apps.idle.timeoutMinutes` (or an App's `runtime.idleTimeoutMinutes`) is set. The first
  request after idling gets a "starting" page until a pod is ready: seconds for a static app,
  up to minutes for a Python app, which reinstalls its pixi environment. Any request to an idle
  App's URL wakes it, including bots on public apps and signed-in users outside a restricted
  App's groups. Apps that can idle carry the authz sidecar, and Python apps there listen on
  8081. Idle detection counts HTTP requests through the sidecar only, so an app that works
  in the background with no visitors needs `runtime.keepAlive: true`. See
  [Scale to zero](/app-crd-reference/#scale-to-zero).
- **Container images are off by default and need non-root images.** `source.type: image`
  works only for registries in `apps.image.allowedRegistries`, and the cluster never builds
  images. The image must run as a non-root user (root images fail with `ImageRunsAsRoot`;
  nothing relaxes the policy), must not listen on 8080 or 8082 (the sidecar's), and gets a
  writable root filesystem but no volumes of its own. Pull secrets come from the chart and
  are shared by every image App in a namespace; there is no per-App registry credential.
  See [Container images](/launching-apps/#container-images).
- **One API version (`v1alpha1`) and no conversion webhook yet.** `helm upgrade` does not
  update CRDs; re-apply `charts/nebari-apps/crds/` on upgrades (see [Upgrading](/upgrading/)).
- **The MCP server must run as a single replica**: handshake-era MCP sessions are held in
  process memory.
- **The MCP sign-in client is created by hand.** The nebari-operator cannot provision a
  Keycloak client with a loopback redirect URI yet; see [The sign-in client](/mcp/#the-sign-in-client).
- **Local dev disables authentication** (`api.auth.enabled=false` with `tls.enabled=false`;
  the chart refuses that with TLS on unless `api.auth.insecureAllowAnonymous=true`). Never
  carry that flag to a real cluster.
