# nebari-apps

![Version: 0.1.0](https://img.shields.io/badge/Version-0.1.0-informational?style=flat-square) ![Type: application](https://img.shields.io/badge/Type-application-informational?style=flat-square) ![AppVersion: 0.1.0](https://img.shields.io/badge/AppVersion-0.1.0-informational?style=flat-square)

Nebari Apps Pack - launch, manage, and observe static web applications on a Nebari cluster. Installs the App CRD and the apps-operator that reconciles Apps into Deployments, Services, and NebariApps.

Installation, the Argo CD Application, upgrades and every setting in context are covered in the
[Apps Pack docs](https://packs.nebari.dev/apps-pack/). This page is generated from the `# --`
comments in [values.yaml](values.yaml) by [helm-docs](https://github.com/norwoodj/helm-docs);
edit those and regenerate (see CONTRIBUTING.md) rather than editing it.

```sh
helm install nebari-apps oci://ghcr.io/nebari-dev/apps-pack/charts/nebari-apps \
  --namespace nebari-apps --create-namespace \
  --set clusterDomain=example.ai --set keycloak.url=https://keycloak.example.ai/auth
```

Every value is checked against [values.schema.json](values.schema.json): an unknown key or a
wrong type fails the install.

## Values

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| api.adminGroups | list | `["admin"]` | Keycloak groups whose members see and manage every App. Everyone else sees and manages only the Apps they launched (`spec.owner`); Apps without an owner (created with kubectl) are admin-only. |
| api.allowedNamespaces | list | `["apps"]` | Namespaces users may launch apps into. An empty list falls back to every namespace labeled `nebari.dev/managed=true`. |
| api.auth.enabled | bool | `true` | Keycloak JWT bearer auth for the API (and keycloak-js login in the UI). Disable only for local development without a browser-reachable Keycloak. |
| api.auth.insecureAllowAnonymous | bool | `false` | Rendering fails when auth is disabled on a TLS (i.e. real) install, because the API would then be anonymous with cluster-wide write RBAC. Set this only if you really mean to run an unauthenticated API. |
| api.enabled | bool | `true` | Deploy apps-api (the REST API behind the UI and MCP server). |
| api.extraEnv | list | `[]` | Extra environment variables for apps-api, after the chart's own (an entry with the same name wins). |
| api.image.pullPolicy | string | `"IfNotPresent"` | Image pull policy. |
| api.image.repository | string | `"ghcr.io/nebari-dev/apps-pack/apps-api"` | apps-api image repository. |
| api.image.tag | string | `""` | Image tag. Empty defaults to the chart's appVersion. |
| api.replicaCount | int | `1` | apps-api replicas. |
| api.resources | object | `{"limits":{"cpu":"500m","memory":"256Mi"},"requests":{"cpu":"500m","memory":"256Mi"}}` | Container resources. Requests equal limits, so the pod is Guaranteed. |
| apps.defaultResources | object | see values.yaml | Requests/limits the operator fills in for any cpu/memory value an App's `runtime.resources` leaves unset, so no launched container runs unbounded. A filled limit never drops below the App's own request. `static` is nginx serving files; `python` is `runtime.pixiTask` apps (pixi installs on cold start, so they burst above their request). |
| apps.idle.timeoutMinutes | int | `0` | Cluster default idle timeout in minutes; `0` keeps apps running unless they set `runtime.idleTimeoutMinutes`. Otherwise at least 5. |
| apps.landingPage.enabled | bool | `false` | Cluster default for registering launched apps as tiles on the Nebari landing page. Off: apps are reachable at their URL and listed in the Apps UI, but get a tile only if the App sets `spec.landingPage.enabled: true`. On: every app gets a tile unless it sets `enabled: false`. The UI's own "Apps" tile is separate (`ui.landingPage`). |
| apps.limitRange.default | object | `{"cpu":"500m","memory":"512Mi"}` | Default limits for containers that set none. |
| apps.limitRange.defaultRequest | object | `{"cpu":"50m","memory":"64Mi"}` | Default requests for containers that set none. |
| apps.limitRange.enabled | bool | `false` | Render a LimitRange so any container without requests/limits (including ones created outside this pack) gets these defaults, plus a per-container max. |
| apps.limitRange.max | object | `{"cpu":"4","memory":"4Gi"}` | Per-container maximum. |
| apps.networkPolicy.blockedCIDRs | list | `["10.0.0.0/8","172.16.0.0/12","192.168.0.0/16","100.64.0.0/10","169.254.0.0/16"]` | Egress destinations app pods may not reach (private, CGNAT and link-local ranges). |
| apps.networkPolicy.enabled | bool | `false` | Render a NetworkPolicy for launched app pods: ingress only from the gateway namespace on the app port (and from the operator on the sidecar's health port, for the idle check), egress only to DNS and to the internet minus `blockedCIDRs`, so user code cannot reach cluster-internal services. git/pixi sources still clone and install from the internet. Needs a CNI that enforces NetworkPolicy. |
| apps.networkPolicy.gatewayNamespace | string | `"envoy-gateway-system"` | Namespace of the Envoy gateway pods allowed to reach app pods. |
| appsDomain | string | `""` | Domain apps are exposed under: `https://<subdomain>.<appsDomain>`. Empty defaults to `apps.<clusterDomain>`, e.g. `my-app.apps.example.ai`. |
| authz.image.pullPolicy | string | `"IfNotPresent"` | Image pull policy. |
| authz.image.repository | string | `"ghcr.io/nebari-dev/apps-pack/apps-authz"` | apps-authz image repository. |
| authz.image.tag | string | `""` | Image tag. Empty defaults to the chart's appVersion. |
| authz.resources | object | `{"limits":{"cpu":"100m","memory":"64Mi"},"requests":{"cpu":"10m","memory":"32Mi"}}` | Sidecar resources, per restricted app pod (on top of the app container's own). |
| clusterDomain | string | `""` | Required. The cluster's base domain; there is no sensible default. |
| fullnameOverride | string | `""` | Override the full resource-name prefix. |
| gateway | string | `"public"` | Shared Gateway that app NebariApps attach to: `public` or `internal`. |
| gitImage | string | `"alpine/git:v2.47.2"` | Image used by init containers to fetch git sources. |
| keycloak.internalUrl | string | `""` | Optional in-cluster Keycloak URL (split horizon) the API, the MCP server and the authz sidecar fetch JWKS from. The sidecar accepts tokens issued under either URL. |
| keycloak.realm | string | `"nebari"` | Keycloak realm. |
| keycloak.url | string | `""` | Browser-facing Keycloak base URL, e.g. `https://keycloak.example.ai/auth`. Required when `api.auth.enabled`, and (or `internalUrl`) for apps that list `access.groups`/`access.users`. |
| mcp.enabled | bool | `true` | Deploy the MCP server. Agents connect at `https://<ui hostname>/mcp` (streamable HTTP); the UI's nginx proxies `/mcp` to it, so there is no separate hostname. When off, `/mcp` returns 404. |
| mcp.extraEnv | list | `[]` | Extra environment variables for apps-mcp, after the chart's own (an entry with the same name wins). |
| mcp.image.pullPolicy | string | `"IfNotPresent"` | Image pull policy. |
| mcp.image.repository | string | `"ghcr.io/nebari-dev/apps-pack/apps-mcp"` | apps-mcp image repository. |
| mcp.image.tag | string | `""` | Image tag. Empty defaults to the chart's appVersion. |
| mcp.replicaCount | int | `1` | apps-mcp replicas. |
| mcp.resources | object | `{"limits":{"cpu":"250m","memory":"256Mi"},"requests":{"cpu":"250m","memory":"256Mi"}}` | Container resources. Requests equal limits, so the pod is Guaranteed. |
| nameOverride | string | `""` | Override the chart name used in resource names. |
| operator.extraEnv | list | `[]` | Extra environment variables for the operator container. |
| operator.image.pullPolicy | string | `"IfNotPresent"` | Image pull policy. |
| operator.image.repository | string | `"ghcr.io/nebari-dev/apps-pack/apps-operator"` | Operator image repository. |
| operator.image.tag | string | `""` | Image tag. Empty defaults to the chart's appVersion. |
| operator.leaderElection | bool | `true` | Elect a leader so only one replica reconciles at a time. |
| operator.replicaCount | int | `1` | Operator replicas (one leads when `leaderElection` is on). |
| operator.resources | object | `{"limits":{"cpu":"500m","memory":"256Mi"},"requests":{"cpu":"500m","memory":"256Mi"}}` | Container resources. Requests equal limits, so the pod is Guaranteed. |
| pythonImage | string | `"ghcr.io/prefix-dev/pixi:0.68.1-noble"` | Image running Python/pixi apps (`runtime.pixiTask`). Must provide the `pixi` binary and run as a non-root user. |
| staticImage | string | `"nginxinc/nginx-unprivileged:1.27-alpine"` | Image serving static app content. Must listen on 8080 as a non-root user; the operator mounts its nginx server config over /etc/nginx/conf.d. |
| telemetry.enabled | bool | `false` | Render ServiceMonitors for the operator and apps-api (needs the Prometheus Operator CRDs) and the `prometheus.io/*` scrape annotations on the operator's metrics Service. |
| telemetry.metricsReaders | list | `[]` | ServiceAccounts allowed to scrape, bound to the metrics-reader ClusterRole, e.g. `[{ name: prometheus-k8s, namespace: monitoring }]`. |
| telemetry.prometheusRule.apiErrorRatio | float | `0.05` | Fraction of API requests that may fail with a 5xx before NebariAppsAPIErrorRate fires. |
| telemetry.prometheusRule.enabled | bool | `false` | Render a PrometheusRule (needs the Prometheus Operator CRDs) with alerts for the operator and API being down, reconcile errors and backlog, the API's 5xx ratio, and pack pods that are unavailable or restarting. The pod alerts need kube-state-metrics. Each alert links its runbook section. |
| telemetry.prometheusRule.labels | object | `{}` | Extra PrometheusRule labels, e.g. the label your Prometheus selects rules on. |
| telemetry.prometheusRule.runbookUrl | string | `"https://packs.nebari.dev/apps-pack/runbook/"` | Base URL of the runbook the alerts link to. |
| telemetry.serviceMonitor.interval | string | `"30s"` | Scrape interval. |
| telemetry.serviceMonitor.labels | object | `{}` | Extra ServiceMonitor labels, e.g. the release label your Prometheus selects on. |
| tls.enabled | bool | `true` | TLS for everything this pack exposes (the UI and every launched app). Disable to serve plain HTTP: no certificates, no HTTPS listeners (local development only; keep enabled on real clusters). |
| ui.branding.banners | object | `{"bottom":{},"top":{}}` | Optional classification banners (e.g. U.S. government CUI markings), full-width above the header (`top`) and below the content (`bottom`), each `{ text, background, foreground }`. A banner is off while its text is empty; without colors it uses the theme's inverted colors. Example: `{ top: { text: "CUI", background: "#502b85", foreground: "#ffffff" } }` |
| ui.branding.faviconUrl | string | `""` | Custom favicon URL. Empty keeps the built-in favicon. |
| ui.branding.logoUrl | string | `""` | Custom header logo: an absolute http(s) URL, a root-relative path, or a base64 `data:` image URI. Empty keeps the built-in Nebari logo. |
| ui.branding.logoUrlDark | string | `""` | Custom dark-mode logo. Empty falls back to `logoUrl`, then the built-in Nebari dark logo. |
| ui.branding.theme | object | `{"dark":{},"light":{}}` | CSS variable overrides applied at runtime, per mode (`light`, `dark`), with no image rebuild. Values are validated in the browser and dropped if they contain CSS-injection characters. Supported tokens: primary, primaryForeground, primaryHover, background, foreground, secondary, secondaryForeground, muted, mutedForeground, accent, accentForeground, border, ring, radius, sidebarPrimary, sidebarPrimaryForeground, sidebarRing, headerBackground, headerForeground, headerBorder, bodyBackground. primaryHover and the sidebar tokens derive from primary / primaryForeground / ring, so those three are normally enough. Other camelCase keys pass through as the matching `--kebab-case` property but are unsupported. Example: `{ light: { primary: "oklch(55% 0.19 250)", primaryForeground: "#ffffff" } }` |
| ui.enabled | bool | `true` | Deploy the web UI (also the nginx front door that proxies `/api/` and `/mcp`). |
| ui.existingConfigMap | string | `""` | Name of an existing ConfigMap holding `config.json` (title and branding) to serve instead of the one rendered from `ui.title` and `ui.branding`. Changes to it roll the UI only on the next upgrade or restart. |
| ui.extraEnv | list | `[]` | Extra environment variables for the UI's nginx container. |
| ui.hostname | string | `""` | Hostname for the UI. Empty defaults to the apps domain itself, so the UI lives at `https://apps.<clusterDomain>` and launched apps at `https://<name>.apps.<clusterDomain>`. |
| ui.image.pullPolicy | string | `"IfNotPresent"` | Image pull policy. |
| ui.image.repository | string | `"ghcr.io/nebari-dev/apps-pack/apps-ui"` | apps-ui image repository. |
| ui.image.tag | string | `""` | Image tag. Empty defaults to the chart's appVersion. |
| ui.landingPage.category | string | `"Platform"` | Landing-page group the tile appears in. |
| ui.landingPage.description | string | `"Launch and manage web applications on this cluster."` | Tile blurb. |
| ui.landingPage.displayName | string | `"Apps"` | Tile label. |
| ui.landingPage.healthCheck.enabled | bool | `true` | Have the nebari-operator poll the UI's health endpoint and show up/down status on the tile. |
| ui.landingPage.healthCheck.intervalSeconds | int | `30` | Seconds between checks. |
| ui.landingPage.healthCheck.path | string | `"/healthz"` | Health endpoint path. |
| ui.landingPage.healthCheck.timeoutSeconds | int | `5` | Seconds before a check counts as failed. |
| ui.landingPage.icon | string | `""` | Tile icon: an absolute http(s) URL or `data:` URI. Empty uses the pack's built-in icon (files/icon.svg). |
| ui.replicaCount | int | `1` | apps-ui replicas. |
| ui.resources | object | `{"limits":{"cpu":"250m","memory":"128Mi"},"requests":{"cpu":"250m","memory":"128Mi"}}` | Container resources. Requests equal limits, so the pod is Guaranteed. |
| ui.title | string | `""` | Browser-tab title. Empty keeps the built-in default ("Nebari Apps"). |
