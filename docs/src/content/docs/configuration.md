---
title: Configuration
description: Every chart value, the environment each service reads, and the NebariApp fields the chart emits.
---

The chart's defaults live in
[`charts/nebari-apps/values.yaml`](https://github.com/nebari-dev/apps-pack/blob/main/charts/nebari-apps/values.yaml).
A ready-to-edit values file for a full Nebari deployment is at
[`examples/nebari-values.yaml`](https://github.com/nebari-dev/apps-pack/blob/main/examples/nebari-values.yaml);
only `clusterDomain` and `keycloak.url` need changing.

## Cluster integration

| Value | Default | Purpose |
|---|---|---|
| `clusterDomain` | — **(required)** | The cluster's base domain. The chart fails to render without it. |
| `appsDomain` | `apps.<clusterDomain>` | Domain apps are served under: `https://<subdomain>.<appsDomain>`. |
| `gateway` | `public` | Shared Gateway the UI's and every app's `NebariApp` attach to (`public` \| `internal`). |
| `tls.enabled` | `true` | TLS for the UI and every launched app. `false` serves plain HTTP (no certificates); local dev only. |
| `keycloak.url` | — (required when `api.auth.enabled`) | Browser-facing Keycloak base URL, e.g. `https://keycloak.example.ai/auth`. |
| `keycloak.realm` | `nebari` | Realm the API validates tokens against and the UI/MCP log in to. |
| `keycloak.internalUrl` | — | In-cluster Keycloak URL (split horizon) used only to fetch JWKS. |

## Launched apps

| Value | Default | Purpose |
|---|---|---|
| `apps.defaultResources.static` / `.python` | 50m/64Mi → 500m/256Mi; 250m/512Mi → 2/2Gi | Requests/limits filled in for any cpu/memory value an App's `runtime.resources` leaves unset (static apps vs `runtime.pixiTask` apps). |
| `apps.limitRange.enabled` | `false` | Render a `LimitRange` (`default`, `defaultRequest`, `max`) into every `api.allowedNamespaces` namespace. The namespaces must exist. |
| `apps.networkPolicy.enabled` | `false` | Render a `NetworkPolicy` for launched app pods in every `api.allowedNamespaces` namespace: ingress only from `gatewayNamespace` on port 8080; egress only to DNS and to the internet minus `blockedCIDRs` (private, CGNAT and link-local ranges by default), so app code cannot reach cluster-internal services. Needs a CNI that enforces NetworkPolicy. |
| `apps.landingPage.enabled` | `false` | Cluster default for registering launched apps as tiles on the Nebari landing page. Off: an app appears only if it sets `spec.landingPage.enabled: true`. On: every app gets a tile unless it sets `enabled: false`. Apps are reachable at their URL and listed in the Apps UI either way. |
| `staticImage` | `nginxinc/nginx-unprivileged:1.27-alpine` | Serves static app content; must listen on 8080 as non-root. |
| `gitImage` | `alpine/git:v2.47.2` | Init-container image that clones `git` sources. |
| `pythonImage` | `ghcr.io/prefix-dev/pixi:0.68.1-noble` | Runs Python/pixi apps (`runtime.pixiTask`); must provide `pixi` and run as non-root. |

## apps-operator

| Value | Default | Purpose |
|---|---|---|
| `operator.image.repository` / `tag` / `pullPolicy` | `ghcr.io/nebari-dev/apps-pack/apps-operator` / `""` (chart `appVersion`) / `IfNotPresent` | Operator image. |
| `operator.replicaCount` | `1` | Replicas; more than one needs `leaderElection`. |
| `operator.leaderElection` | `true` | Lease-based leader election in the release namespace. |
| `operator.resources` | `100m/128Mi` requests, `500m/256Mi` limits | Pod resources. |

The operator reads its configuration from flags the chart renders
(`--apps-domain`, `--gateway`, `--static-image`, `--git-image`, `--python-image`,
`--tls-disabled`, `--landing-page`, `--leader-elect`); each flag also accepts the matching
environment variable (`APPS_DOMAIN`, `GATEWAY`, `STATIC_IMAGE`, `GIT_IMAGE`, `PYTHON_IMAGE`,
`TLS_DISABLED`, `LANDING_PAGE`).

## apps-api

| Value | Default | Purpose |
|---|---|---|
| `api.enabled` | `true` | Deploy the REST API (the UI and MCP are thin clients over it). |
| `api.image.repository` / `tag` / `pullPolicy` | `ghcr.io/nebari-dev/apps-pack/apps-api` / `""` / `IfNotPresent` | API image. |
| `api.replicaCount` | `1` | The API is stateless; more replicas are safe. |
| `api.auth.enabled` | `true` | Keycloak JWT bearer auth for the API and keycloak-js login in the UI. **Disable only for local development**; off, every caller is anonymous with full access. Rendering fails if it is off while `tls.enabled=true`, unless `api.auth.insecureAllowAnonymous` is set. |
| `api.auth.insecureAllowAnonymous` | `false` | Explicit opt-in to an unauthenticated API on a TLS install. Leave off. |
| `api.adminGroups` | `["admin"]` | Keycloak groups whose members see and manage every App. Everyone else sees and manages only the Apps they launched. |
| `api.allowedNamespaces` | `["apps"]` | Namespaces users may launch into. Empty list = every namespace labeled `nebari.dev/managed=true`. `default` and `kube-*` are never offered. The API gets a `RoleBinding` in each listed namespace (they must exist before install/upgrade); an empty list binds its namespaced role cluster-wide instead. |
| `api.resources` | `100m/128Mi` requests, `500m/256Mi` limits | Pod resources. |

Environment the API container receives: `APPS_DOMAIN`, `APPS_NAMESPACES`, `APPS_ADMIN_GROUPS`, `AUTH_ENABLED`,
`TLS_DISABLED`, `OIDC_ISSUER`, `OIDC_ISSUER_INTERNAL`, `UI_KEYCLOAK_URL`, `UI_KEYCLOAK_REALM`,
`UI_KEYCLOAK_CLIENT_ID` and `OIDC_DEVICE_CLIENT_ID` (from the Secret the UI's `NebariApp`
provisions), and `OIDC_ALLOWED_CLIENTS` (built from those two: a token is accepted only if its
`azp` or `aud` names one of them; if the Secret is missing every token is rejected). The MCP
server receives the same `OIDC_ALLOWED_CLIENTS`. Not rendered by the chart but honoured when set on the container: `OIDC_JWKS_URL`, `OIDC_AUDIENCE`,
`LOG_LEVEL` (default `INFO`), `MAX_UPLOAD_BYTES` (default 921600, the cap on an upload and on its extracted contents) and
`MAX_REQUEST_BYTES` (default 2097152, the cap on any request body, enforced while it streams
in).

## apps-ui

| Value | Default | Purpose |
|---|---|---|
| `ui.enabled` | `true` | Deploy the web UI (also the nginx front door that proxies `/api/` and `/mcp`). |
| `ui.image.repository` / `tag` / `pullPolicy` | `ghcr.io/nebari-dev/apps-pack/apps-ui` / `""` / `IfNotPresent` | UI image. |
| `ui.replicaCount` | `1` | Replicas. |
| `ui.hostname` | `<appsDomain>` | Hostname the UI is served at. |
| `ui.title` | `Nebari Apps` | Browser-tab title. |
| `ui.branding.logoUrl` / `logoUrlDark` / `faviconUrl` | built-in Nebari assets | Logo and favicon overrides (http(s), root-relative, or `data:` image URI). |
| `ui.branding.theme.light` / `dark` | `{}` | CSS token overrides, validated in the browser — see [Branding](/branding/). |
| `ui.branding.banners.top` / `bottom` | `{}` | Classification banners (`text`, `background`, `foreground`). |
| `ui.landingPage.displayName` / `description` / `category` / `icon` | `Apps` / `Launch and manage web applications on this cluster.` / `Platform` / built-in icon | The pack's own tile on the landing page (always registered while `ui.enabled`). |
| `ui.landingPage.healthCheck.enabled` / `path` / `intervalSeconds` / `timeoutSeconds` | `true` / `/healthz` / `30` / `5` | Health indicator next to the tile, polled by the nebari-operator. |
| `ui.resources` | `50m/64Mi` requests, `250m/128Mi` limits | Pod resources. |

## apps-mcp

| Value | Default | Purpose |
|---|---|---|
| `mcp.enabled` | `true` | Deploy the MCP server at `https://<ui hostname>/mcp` (proxied by the UI's nginx; no separate hostname). When off, `/mcp` returns 404. |
| `mcp.image.repository` / `tag` / `pullPolicy` | `ghcr.io/nebari-dev/apps-pack/apps-mcp` / `""` / `IfNotPresent` | MCP image. |
| `mcp.replicaCount` | `1` | **Keep at 1**: device-flow sessions are held in process memory. |
| `mcp.resources` | `50m/128Mi` requests, `250m/256Mi` limits | Pod resources. |

Environment: `API_URL`, `AUTH_ENABLED`, `OIDC_ISSUER`, `OIDC_ISSUER_INTERNAL`,
`OIDC_DEVICE_CLIENT_ID` (from the UI's OIDC Secret); optional `OIDC_JWKS_URL`,
`OIDC_AUDIENCE`, `HOST`, `PORT`, `LOG_LEVEL`, `MCP_SESSION_TTL_SECONDS` (default 28800:
how long an idle device-flow login is kept).

## Logs and probes

apps-api and apps-mcp write one JSON object per line to stdout (`timestamp`, `level`,
`logger`, `event`, plus fields). Every HTTP request gets an access line with `request_id`,
`method`, `path`, `status`, `duration_ms` and, on the API, the authenticated `user`. The
id comes from the incoming `X-Request-ID` header (on a Nebari cluster, the one Envoy
assigns at the gateway) or is generated, and is returned on the response. The UI's nginx and the MCP server pass it on to apps-api, and MCP tool calls log
it with the `tool` name, so one id ties a browser or agent action to the API's lines for
it. Probe requests log at `DEBUG`.

| Component | Liveness | Readiness |
|---|---|---|
| apps-api | `GET /api/v1/healthz` | `GET /api/v1/readyz`: Kubernetes API reachable and, with auth on, the realm JWKS loads |
| apps-mcp | `GET /healthz` | `GET /healthz` |
| apps-ui | `GET /healthz` | `GET /healthz` |

## Metrics

The apps-operator serves the standard controller-runtime metrics at `/metrics` on the
`<release>-operator-metrics` Service, port `8443`: reconcile counts, durations and errors
for the `app` controller, work-queue depth, client request rates, and Go runtime stats. The
endpoint is HTTPS only, with a self-signed certificate. Each scrape's bearer token is checked
with a `TokenReview` and a `SubjectAccessReview`, so it must belong to a ServiceAccount
bound to the `<release>-metrics-reader` ClusterRole (`get` on the `/metrics` URL). Anything
else gets `401` or `403`.

| Value | Default | Purpose |
|---|---|---|
| `telemetry.enabled` | `false` | Render a `ServiceMonitor` for the operator (needs the Prometheus Operator CRDs) and `prometheus.io/*` scrape annotations on the metrics Service. |
| `telemetry.serviceMonitor.labels` | `{}` | Extra labels on the ServiceMonitor, e.g. the `release` label your Prometheus selects on. |
| `telemetry.serviceMonitor.interval` | `30s` | Scrape interval. |
| `telemetry.metricsReaders` | `[]` | ServiceAccounts (`{name, namespace}`) bound to the metrics-reader ClusterRole: list your Prometheus or Alloy account here. |

The ServiceMonitor scrapes with Prometheus's own ServiceAccount token and skips certificate
verification, since the certificate is regenerated on every operator start. To check the
endpoint by hand:

```bash
kubectl -n nebari-apps port-forward svc/nebari-apps-operator-metrics 8443 &
curl -sk -H "Authorization: Bearer $(kubectl -n monitoring create token <reader-sa>)" \
  https://127.0.0.1:8443/metrics | grep controller_runtime_reconcile_total
```

## Overrides

| Value | Default | Purpose |
|---|---|---|
| `nameOverride` / `fullnameOverride` | `""` | Standard Helm name overrides. |

## NebariApp fields the chart emits

The pack integrates with the platform through two kinds of `NebariApp`
(`reconcilers.nebari.dev/v1`). Field semantics are documented in the
[NebariApp CRD reference](https://github.com/nebari-dev/software-pack-template/blob/main/docs/nebariapp-crd-reference.md).

**The UI's `NebariApp`** (`<release>-ui`, rendered by `templates/ui.yaml`):

| Field | Value | Source |
|---|---|---|
| `hostname` | `ui.hostname` or `<appsDomain>` | chart |
| `service.name` / `port` | the UI Service / `8080` | chart |
| `routing.routes` | one `PathPrefix /` route | fixed |
| `routing.tls.enabled` | `tls.enabled` | chart |
| `gateway` | `gateway` | chart |
| `auth.enabled` | `api.auth.enabled` | chart |
| `auth.provider` / `provisionClient` | `keycloak` / `true` | fixed (when auth is on) |
| `auth.enforceAtGateway` | `false` | fixed — the UI logs in itself with keycloak-js; the API checks bearer tokens |
| `auth.redirectURI` | `/*` | fixed |
| `auth.scopes` | `openid profile email groups` | fixed |
| `auth.spaClient.enabled` | `true` | fixed — provisions the public PKCE client the UI uses; its id lands in the `<release>-ui-oidc-client` Secret (`spa-client-id`) |
| `auth.deviceFlowClient.enabled` | `true` when `mcp.enabled` | provisions the RFC 8628 client the MCP server uses (`device-client-id` in the same Secret) |
| `landingPage.enabled` | `true` | fixed |
| `landingPage.displayName` / `description` / `category` / `icon` | `ui.landingPage.*` | chart (`icon` defaults to the bundled SVG as a data URI) |
| `landingPage.healthCheck.*` | `ui.landingPage.healthCheck.*` | chart |

**One `NebariApp` per launched App** (`app-<name>`, emitted by the operator from the App's spec):

| Field | Value | Source |
|---|---|---|
| `hostname` | `<spec.access.subdomain>.<appsDomain>` | App + chart |
| `service.name` / `port` | `app-<name>` / `8080` | operator |
| `routing.routes` | one `PathPrefix /` route | fixed |
| `routing.tls.enabled` | `tls.enabled` | chart |
| `gateway` | `gateway` | chart |
| `auth.enabled` | `!spec.access.public` | App |
| `auth.provider` / `provisionClient` / `scopes` | `keycloak` / `true` / `openid profile email groups` | fixed (private apps) |
| `auth.groups` | `spec.access.groups` | App — **not enforced by the gateway in nebari-operator 0.1.0**; see [Access control](/launching-apps/#access-control) |
| `landingPage.enabled` | `spec.landingPage.enabled`, else `apps.landingPage.enabled` | App, then chart |
| `landingPage.displayName` / `description` / `icon` / `category` | `spec.displayName` / `spec.description` / `spec.thumbnail` / `Apps` | App (only when the tile is enabled) |

Fields the pack never sets: `auth.users`, `auth.enforceAtGateway` on apps (defaults to
enforced), `landingPage.priority`, `landingPage.iconLight`/`iconDark`, `landingPage.externalUrl`.
