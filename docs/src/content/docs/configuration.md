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
| `keycloak.url` | — (required when `api.auth.enabled`) | Browser-facing Keycloak base URL, e.g. `https://keycloak.example.ai/auth`. The authz sidecar also accepts tokens issued under it; apps that list `access.groups` need it or `keycloak.internalUrl`. |
| `keycloak.realm` | `nebari` | Realm the API validates tokens against and the UI/MCP log in to. |
| `keycloak.internalUrl` | — | In-cluster Keycloak URL (split horizon). The API and MCP server fetch JWKS from it; the authz sidecar fetches keys from it and accepts it as a token issuer. |

## Launched apps

| Value | Default | Purpose |
|---|---|---|
| `apps.defaultResources.static` / `.python` | 50m/64Mi → 500m/256Mi; 250m/512Mi → 2/2Gi | Requests/limits filled in for any cpu/memory value an App's `runtime.resources` leaves unset (static apps vs `runtime.pixiTask` and image apps). |
| `apps.image.allowedRegistries` | `[]` (image apps off) | Registries, optionally narrowed to a repository prefix, that `source.type: image` Apps may pull from. See [Image registries](#image-registries). |
| `apps.image.pullSecrets` | `[]` | Names of `kubernetes.io/dockerconfigjson` Secrets image App pods pull with (private registries). Each must exist in every App namespace. |
| `apps.limitRange.enabled` | `false` | Render a `LimitRange` (`default`, `defaultRequest`, `max`) into every `api.allowedNamespaces` namespace. The namespaces must exist. |
| `apps.idle.timeoutMinutes` | `0` | Cluster default for [scale to zero](/app-crd-reference/#scale-to-zero): an App that goes this many minutes without a request is scaled to zero (phase `Idle`) and wakes on the next request to its URL. `0` keeps apps running unless they set `runtime.idleTimeoutMinutes`; otherwise `5`–`43200`. Apps opt out with `runtime.keepAlive: true`. Apps that can idle run the authz sidecar (`authz.resources`) in passthrough mode, which records their activity. |
| `apps.networkPolicy.enabled` | `false` | Render a `NetworkPolicy` for launched app pods in every `api.allowedNamespaces` namespace: ingress only from `gatewayNamespace` on port 8080, plus from the operator pods on port 8082 (the sidecar's health port, which the idle check reads); egress only to DNS and to the internet minus `blockedCIDRs` (private, CGNAT and link-local ranges by default), so app code cannot reach cluster-internal services. Needs a CNI that enforces NetworkPolicy. |
| `apps.landingPage.enabled` | `false` | Cluster default for registering launched apps as tiles on the Nebari landing page. Off: an app appears only if it sets `spec.landingPage.enabled: true`. On: every app gets a tile unless it sets `enabled: false`. Apps are reachable at their URL and listed in the Apps UI either way. |
| `staticImage` | `nginxinc/nginx-unprivileged:1.27-alpine` | Serves static app content; must listen on 8080 as non-root. The operator mounts its nginx server config (security headers, `try_files`) over `/etc/nginx/conf.d`, so a replacement image should be nginx-based or ignore that directory. |
| `gitImage` | `alpine/git:v2.47.2` | Init-container image that clones `git` sources. |
| `pythonImage` | `ghcr.io/prefix-dev/pixi:0.68.1-noble` | Runs Python/pixi apps (`runtime.pixiTask`); must provide `pixi` and run as non-root. |
| `authz.image.repository` / `tag` / `pullPolicy` | `ghcr.io/nebari-dev/apps-pack/apps-authz` / appVersion / `IfNotPresent` | The sidecar the operator adds to apps that list `access.groups`: it takes port 8080, checks the forwarded access token and returns `403` to everyone else (see [Access control](/launching-apps/#access-control)). Apps that can idle and image apps get it too; without groups it runs in passthrough mode and only records when the app last served a request. |
| `authz.resources` | `10m`/`32Mi` requests, `100m`/`64Mi` limits | The sidecar's requests/limits, on top of the app container's, in every pod that runs it. |

### Image registries

Apps with `source.type: image` run a published container image. The feature is **off until a
registry is allowed**, so platform teams decide which registries users may pull from:

```yaml
apps:
  image:
    allowedRegistries:
      - ghcr.io/my-org          # this org's images only
      - docker.io/library       # Docker Hub official images (nginx, redis, ...)
      - registry.example.com:5000
    pullSecrets:
      - registry-credentials    # for private registries
```

- **Matching.** Each entry is `<host>[:port][/<repository prefix>]`. An image's reference is
  normalized the way the container runtime reads it (`nginx:1.27` is
  `docker.io/library/nginx:1.27`), and it is allowed when its `<host>/<repository>` equals an
  entry or continues it with `/`. Hosts compare whole, so `ghcr.io` does not admit
  `ghcr.io.evil.com`; prefixes compare whole path components, so `ghcr.io/my-org` does not
  admit `ghcr.io/my-org-evil`; a port is part of the host. No wildcards. The
  [CRD reference](/app-crd-reference/#image-allowlist-matching) has a table of examples.
- **Where it is enforced.** The operator (`--image-registries`) checks every App, including
  ones written with `kubectl` or GitOps, and scales an image App outside the list to zero
  (reason `ImageNotAllowed`); apps-api (`IMAGE_REGISTRIES`) refuses such requests with `422`
  and reports the list in `GET /capabilities`, which the UI and `describe_cluster` use. Both
  refuse to start with a malformed entry. Removing a registry stops the Apps that use it once
  the operator rolls with the new values (a chart upgrade does that).
- **Allow narrowly.** An image App runs arbitrary code from that registry, inside the same
  non-root, capability-free, resource-limited pod as any other App. Prefer an org prefix to a
  whole public registry, and pair image apps with `apps.networkPolicy.enabled` on shared
  clusters.
- **Pull secrets.** The chart does not create them; create one per App namespace, e.g.
  `kubectl -n apps create secret docker-registry registry-credentials --docker-server=ghcr.io
  --docker-username=… --docker-password=…`. Every image App pod in the namespace pulls with
  it, so any image App may run any image those credentials can read within the allowlist.
  A tag is pulled on every pod start (`imagePullPolicy: Always`), so the registry re-checks
  the credentials each time; a digest is pulled once per node.

## apps-operator

| Value | Default | Purpose |
|---|---|---|
| `operator.image.repository` / `tag` / `pullPolicy` | `ghcr.io/nebari-dev/apps-pack/apps-operator` / `""` (chart `appVersion`) / `IfNotPresent` | Operator image. |
| `operator.replicaCount` | `1` | Replicas; more than one needs `leaderElection`. |
| `operator.leaderElection` | `true` | Lease-based leader election in the release namespace. |
| `operator.resources` | `500m/256Mi` (requests = limits) | Pod resources. |

The operator reads its configuration from flags the chart renders
(`--apps-domain`, `--gateway`, `--static-image`, `--git-image`, `--python-image`,
`--tls-disabled`, `--landing-page`, `--leader-elect`, `--idle-timeout-minutes`,
`--activator-service`, `--activator-namespace`, `--image-registries`,
`--image-pull-secrets`); each flag also accepts the matching
environment variable (`APPS_DOMAIN`, `GATEWAY`, `STATIC_IMAGE`, `GIT_IMAGE`, `PYTHON_IMAGE`,
`TLS_DISABLED`, `LANDING_PAGE`, `IDLE_TIMEOUT_MINUTES`, `ACTIVATOR_SERVICE`,
`IMAGE_REGISTRIES`, `IMAGE_PULL_SECRETS`, and `POD_NAMESPACE` for the activator's namespace).

Every operator replica also serves the **activator** on port 8090 (`--activator-bind-address`),
behind the `<release>-activator` Service: the page an idle App's URL shows while it starts (see
[Scale to zero](/app-crd-reference/#scale-to-zero)). Idle Apps' `NebariApp`s route to that
Service across namespaces, which Gateway API allows through a `ReferenceGrant` named
`<release>-activator` in the release namespace. The operator creates it, adds each App
namespace the first time an App there idles, and owns it by the Service, so uninstalling the
chart removes it. For this the operator has two permissions beyond its reconcile set:
`get`/`list` on pods cluster-wide (read-only and uncached, to find an App's ready pods and ask
their sidecar for activity) and `get`/`create`/`update` on `referencegrants` in the release
namespace.

## apps-api

| Value | Default | Purpose |
|---|---|---|
| `api.enabled` | `true` | Deploy the REST API (the UI and MCP are thin clients over it). |
| `api.image.repository` / `tag` / `pullPolicy` | `ghcr.io/nebari-dev/apps-pack/apps-api` / `""` / `IfNotPresent` | API image. |
| `api.replicaCount` | `1` | The API is stateless; more replicas are safe. |
| `api.auth.enabled` | `true` | Keycloak JWT bearer auth for the API and keycloak-js login in the UI. **Disable only for local development**; off, every caller is anonymous with full access. Rendering fails if it is off while `tls.enabled=true`, unless `api.auth.insecureAllowAnonymous` is set. |
| `api.auth.insecureAllowAnonymous` | `false` | Explicit opt-in to an unauthenticated API on a TLS install. Leave off. |
| `api.adminGroups` | `["admin"]` | Keycloak groups whose members see and manage every App. Everyone else sees and manages only the Apps they launched or manage (`access.managers`). |
| `api.allowedNamespaces` | `["apps"]` | Namespaces users may launch into. Empty list = every namespace labeled `nebari.dev/managed=true`. `default` and `kube-*` are never offered. The API gets a `RoleBinding` in each listed namespace (they must exist before install/upgrade); an empty list binds its namespaced role cluster-wide instead. That role includes `create` and `patch` on Secrets (no `get`/`list`/`watch`) for [App secrets](/architecture/#secrets), so keep this list set on shared clusters. |
| `api.resources` | `500m/256Mi` (requests = limits) | Pod resources. |

Environment the API container receives: `APPS_DOMAIN`, `APPS_NAMESPACES`, `APPS_ADMIN_GROUPS`, `AUTH_ENABLED`,
`TLS_DISABLED`, `IMAGE_REGISTRIES` (from `apps.image.allowedRegistries`), `OIDC_ISSUER`, `OIDC_ISSUER_INTERNAL`, `UI_KEYCLOAK_URL`, `UI_KEYCLOAK_REALM`,
`UI_KEYCLOAK_CLIENT_ID` and `OIDC_DEVICE_CLIENT_ID` (from the Secret the UI's `NebariApp`
provisions), and `OIDC_ALLOWED_CLIENTS` (built from those two plus `mcp.oauth.clientId` when
set: a token is accepted only if its `azp` or `aud` names one of them; if the Secret is missing
only the `mcp.oauth` client's tokens are accepted). The MCP server receives the same
`OIDC_ALLOWED_CLIENTS`. With `mcp.oauth.clientId` set, the API also gets `MCP_OAUTH_CLIENT_ID`
and `MCP_OAUTH_CALLBACK_PORT`, which `GET /api/v1/config` passes to the UI. Not rendered by the chart but honoured when set on the container: `OIDC_JWKS_URL`, `OIDC_AUDIENCE`,
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
| `ui.existingConfigMap` | `""` | Serve `config.json` (title and branding) from an existing ConfigMap instead of rendering it from `ui.title` and `ui.branding`. |
| `ui.branding.banners.top` / `bottom` | `{}` | Classification banners (`text`, `background`, `foreground`). |
| `ui.landingPage.displayName` / `description` / `category` / `icon` | `Apps` / `Launch and manage web applications on this cluster.` / `Platform` / built-in icon | The pack's own tile on the landing page (always registered while `ui.enabled`). |
| `ui.landingPage.healthCheck.enabled` / `path` / `intervalSeconds` / `timeoutSeconds` | `true` / `/healthz` / `30` / `5` | Health indicator next to the tile, polled by the nebari-operator. |
| `ui.resources` | `250m/128Mi` (requests = limits) | Pod resources. |

## apps-mcp

| Value | Default | Purpose |
|---|---|---|
| `mcp.enabled` | `true` | Deploy the MCP server at `https://<ui hostname>/mcp` (proxied by the UI's nginx; no separate hostname). When off, `/mcp` returns 404. |
| `mcp.image.repository` / `tag` / `pullPolicy` | `ghcr.io/nebari-dev/apps-pack/apps-mcp` / `""` / `IfNotPresent` | MCP image. |
| `mcp.replicaCount` | `1` | **Keep at 1**: handshake-era MCP sessions are held in process memory (authentication is per request and does not depend on them). |
| `mcp.oauth.clientId` | `""` | Public Keycloak client MCP clients sign in with ([MCP authentication](/mcp/#the-sign-in-client)); create it in Keycloak first. The chart adds it to the allowed clients of apps-api and apps-mcp, and the UI's `claude mcp add` command passes it as `--client-id`. Empty: MCP clients cannot sign in on their own and need a token from elsewhere. |
| `mcp.oauth.callbackPort` | `33418` | The MCP client's OAuth callback port (`--callback-port`); the client's redirect URI must be `http://localhost:<port>/callback`. |
| `mcp.resources` | `250m/256Mi` (requests = limits) | Pod resources. |
| `mcp.orgCABundle.configMapName` / `key` | `""` / `ca-bundle.crt` | ConfigMap (release namespace) with a PEM CA bundle the MCP server trusts for outbound HTTPS. Set it when `keycloak.url` has a certificate from a private CA (and `keycloak.internalUrl` is not set), or every token is rejected because the JWKS fetch fails with `CERTIFICATE_VERIFY_FAILED`. The bundle replaces the image's trust store, so include the public roots too. |

Environment: `API_URL`, `AUTH_ENABLED`, `OIDC_ISSUER` (the authorization server the
protected resource metadata names), `OIDC_ISSUER_INTERNAL`, `OIDC_ALLOWED_CLIENTS`,
`MCP_PUBLIC_URL` (the UI host's origin; the protected resource is `<MCP_PUBLIC_URL>/mcp`);
optional `OIDC_JWKS_URL`, `OIDC_AUDIENCE`, `HOST`, `PORT`, `LOG_LEVEL`, `SSL_CERT_FILE` (set
by `mcp.orgCABundle`).

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

apps-api serves `/metrics` on its pod port (plain HTTP, no token) with
`apps_api_requests_total{method,route,status}` and
`apps_api_request_duration_seconds{method,route}`. `route` is the route template (for
example `/api/v1/apps/{namespace}/{name}`), so the series count does not grow with the
number of Apps. The UI's nginx proxies only `/api/`, so the endpoint is reachable inside the
cluster but not through the gateway; with `apps.networkPolicy` or your own policies, allow
your Prometheus to reach the API Service.

| Value | Default | Purpose |
|---|---|---|
| `telemetry.enabled` | `false` | Render `ServiceMonitor`s for the operator and apps-api (needs the Prometheus Operator CRDs) and `prometheus.io/*` scrape annotations on the operator's metrics Service. |
| `telemetry.serviceMonitor.labels` | `{}` | Extra labels on the ServiceMonitor, e.g. the `release` label your Prometheus selects on. |
| `telemetry.serviceMonitor.interval` | `30s` | Scrape interval. |
| `telemetry.metricsReaders` | `[]` | ServiceAccounts (`{name, namespace}`) bound to the metrics-reader ClusterRole: list your Prometheus or Alloy account here. |
| `telemetry.prometheusRule.enabled` | `false` | Render a `PrometheusRule` with the alerts in the [runbook](/runbook/#alerts). The pod alerts need kube-state-metrics. |
| `telemetry.prometheusRule.labels` | `{}` | Extra labels on the PrometheusRule, e.g. the label your Prometheus selects rules on. |
| `telemetry.prometheusRule.apiErrorRatio` | `0.05` | Share of API requests that may fail with a 5xx before `NebariAppsAPIErrorRate` fires. |
| `telemetry.prometheusRule.runbookUrl` | `https://packs.nebari.dev/apps-pack/runbook/` | Base URL of the runbook the alerts' `runbook_url` annotations point to; override it to link a fork or an internal copy. |

The ServiceMonitor scrapes with Prometheus's own ServiceAccount token and skips certificate
verification, since the certificate is regenerated on every operator start. To check the
endpoint by hand:

```bash
kubectl -n nebari-apps port-forward svc/nebari-apps-operator-metrics 8443 &
curl -sk -H "Authorization: Bearer $(kubectl -n monitoring create token <reader-sa>)" \
  https://127.0.0.1:8443/metrics | grep controller_runtime_reconcile_total
```

## Overrides

Every value is validated against the chart's `values.schema.json`, so an unknown key, a
typo or a wrong type fails `helm install` instead of being ignored. The full generated list of
values is in the [chart README](https://github.com/nebari-dev/apps-pack/blob/main/charts/nebari-apps/README.md).
All four pack pods (operator, api, ui, mcp) run with a read-only root filesystem; their only
writable paths are `emptyDir` volumes (`/tmp` for api and mcp, `/tmp/nginx` for the UI).

| Value | Default | Purpose |
|---|---|---|
| `nameOverride` / `fullnameOverride` | `""` | Standard Helm name overrides. |
| `operator.extraEnv` / `api.extraEnv` / `ui.extraEnv` / `mcp.extraEnv` | `[]` | Extra container env vars (Kubernetes `EnvVar` list), added after the chart's own so a same-named entry wins. |

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
| `auth.deviceFlowClient.enabled` | `true` when `mcp.enabled` | provisions an RFC 8628 client (`device-client-id` in the same Secret) whose tokens apps-api and apps-mcp accept, for CLIs and scripts that send a bearer token themselves |
| `landingPage.enabled` | `true` | fixed |
| `landingPage.displayName` / `description` / `category` / `icon` | `ui.landingPage.*` | chart (`icon` defaults to the bundled SVG as a data URI) |
| `landingPage.healthCheck.*` | `ui.landingPage.healthCheck.*` | chart |

**One `NebariApp` per launched App** (`app-<name>`, emitted by the operator from the App's spec):

| Field | Value | Source |
|---|---|---|
| `hostname` | `<spec.access.subdomain>.<appsDomain>` | App + chart |
| `service.name` / `port` | `app-<name>` / `8080` | operator |
| `service.namespace` | unset; the release namespace (with `service.name` `<release>-activator`) while the App is `Idle` or waking | operator — routes to the activator ([Scale to zero](/app-crd-reference/#scale-to-zero)); needs the `ReferenceGrant` above |
| `routing.routes` | one `PathPrefix /` route | fixed |
| `routing.tls.enabled` | `tls.enabled` | chart |
| `gateway` | `gateway` | chart |
| `auth.enabled` | `!spec.access.public` | App |
| `auth.provider` / `provisionClient` / `scopes` | `keycloak` / `true` / `openid profile email groups` | fixed (private apps) |
| `auth.groups` | `spec.access.groups` | App — landing-page tile visibility; the gateway does not enforce it, the authz sidecar in the app pod does (see [Access control](/launching-apps/#access-control)) |
| `auth.forwardAccessToken` | `true` when `spec.access.groups` is set (private apps) | App — the gateway forwards the access token the authz sidecar checks |
| `auth.enforceAtGateway` | `true`, with `forwardAccessToken` | fixed — the `NebariApp` CRD requires it for `forwardAccessToken` (it is also the default) |
| `landingPage.enabled` | `spec.landingPage.enabled`, else `apps.landingPage.enabled` | App, then chart |
| `landingPage.displayName` / `description` / `icon` / `category` | `spec.displayName` / `spec.description` / `spec.thumbnail` / `Apps` | App (only when the tile is enabled) |

Fields the pack never sets: `auth.users` (Apps restrict access by group only),
`auth.enforceAtGateway` on unrestricted apps (defaults to enforced),
`landingPage.priority`, `landingPage.iconLight`/`iconDark`, `landingPage.externalUrl`.
