---
title: Troubleshooting
description: Diagnose Apps that do not launch, routing and sign-in failures, and install problems on a cluster.
---

Start with the App itself: its phase, conditions and message say which stage of the
[reconcile pipeline](/architecture/#the-reconcile-pipeline) stopped.

```bash
kubectl get apps -A
kubectl -n <namespace> describe app <name>        # conditions + recent events
kubectl -n <namespace> get app <name> -o jsonpath='{.status.message}{"\n"}'
```

| Condition `False` | Stage | Look at |
|---|---|---|
| `Validated` | The spec or namespace was refused; nothing was created. Terminal until the spec changes. | `status.message` (below) |
| `WorkloadReady` | Pods are not ready. | `kubectl -n <ns> get pods -l apps.nebari.dev/app=<name>`, pod logs |
| `RoutingReady` | The `NebariApp` is not ready: route, certificate or Keycloak client. | `kubectl -n <ns> describe nebariapp app-<name>` |

The UI's app page and the MCP `get_app_status` tool show the same conditions.

## The App is `Failed` with `Validated=False`

| `status.message` | Fix |
|---|---|
| `namespace "x" is not opted in: label nebari.dev/managed=true is required` | `kubectl label namespace x nebari.dev/managed=true`. The App re-validates on its own. |
| reason `SubdomainTaken` | Another App already serves that subdomain; the oldest App keeps it. Pick another `access.subdomain` (it is immutable, so delete and re-create the App). |
| `source.git.url: only https:// URLs are allowed …`, `… must not contain credentials …`, `host "…" is not allowed …` | Git sources must be public `https://` URLs on a public host. Private repositories are not supported yet. |
| `source.git.ref must not start with '-'`, `source.git.subdir must not contain '..'` | Fix the ref or subdir. |
| `source.pvc: PersistentVolumeClaim "x" not found …` | The claim must exist in the App's namespace. |
| `source.pvc: PersistentVolumeClaim "x" is not labeled apps.nebari.dev/mountable=true …` | The claim's owner opts in with `kubectl -n <ns> label pvc x apps.nebari.dev/mountable=true`. |
| `source.inline.files: path "…" must be relative …` | Inline file names are relative paths without `..`. |

## Pods never become ready

```bash
kubectl -n <ns> get pods -l apps.nebari.dev/app=<name>
kubectl -n <ns> logs deploy/app-<name> -c git-clone     # git sources (init container)
kubectl -n <ns> logs deploy/app-<name> -c copy-source   # Python apps (init container)
kubectl -n <ns> logs deploy/app-<name> -c app           # the app itself
```

- **`Init:CrashLoopBackOff` on `git-clone`.** The clone failed: the repository is private or
  gone, or `ref` is a commit SHA. Refs are cloned with `git clone --branch`, so use a branch
  or tag.
- **Static app serves 404 / a blank page.** The content root has no `index.html`. For git
  sources, point `source.git.subdir` at the directory that holds it.
- **Python app restarts or is `OOMKilled`.** The `app` container runs `pixi install` before
  your task, and the install needs more memory than the app does. Raise
  `runtime.resources.limits.memory` (cluster default: `apps.defaultResources.python`). A
  `pixi.lock` makes the install `--locked` and faster.
- **Python app is `Running` but never ready.** The task must listen on `0.0.0.0:$PORT` (the
  pod gets `PORT=8080`). A server bound to `127.0.0.1` fails the readiness probe. An App
  that lists `access.groups` or `access.users` gets `PORT=8081`, because the authz sidecar
  takes 8080: a task that hard-codes 8080 then collides with the sidecar.
- **A restricted app returns `403` to someone who should get in.** The sidecar's log says
  why (`kubectl logs deploy/app-<name> -c authz`): not in an allowed group or user list,
  token issued to another client, issuer not accepted (check `keycloak.url` and
  `keycloak.internalUrl`), or expired. Group changes reach the token on its next refresh
  (5 minutes by default). A `401` means the gateway forwarded no token: the `NebariApp` has
  no `auth.forwardAccessToken` (nebari-operator older than `%NEBARI_OPERATOR_VERSION%`).
- **A restricted app stays `Failed` with "need the realm's URL" or "--authz-image".** Set
  the chart's `keycloak.url` (or `keycloak.internalUrl`) and keep `authz.image`.
- **`Pending` with `FailedScheduling`.** The namespace's quota or the nodes cannot fit the
  requests; lower `runtime.resources.requests` or `replicas`.

## `RoutingReady=False`

The `NebariApp` is reconciled by the nebari-operator, not this pack:

```bash
kubectl -n <ns> describe nebariapp app-<name>
kubectl -n nebari-operator-system logs deploy/nebari-operator-controller-manager
```

- **Reason `NebariAppMissing` that does not clear.** The `NebariApp` CRD is missing: install
  nebari-operator `%NEBARI_OPERATOR_VERSION%` or later.
- **Certificate not ready.** cert-manager could not issue `<subdomain>.<appsDomain>`; check
  `kubectl -n <ns> get certificate,challenge`. Local clusters without public DNS should set
  `tls.enabled=false`.
- **The URL resolves nowhere.** `*.apps.<cluster-domain>` (the `appsDomain`) needs a
  wildcard DNS record pointing at the gateway.

## Signing in and API errors

- **The UI keeps redirecting to Keycloak, or every call returns `401`.** The API refuses
  tokens that were not issued by this pack's own Keycloak clients or that fail JWKS
  verification; the `401` body says why (`invalid token: …`). An issuer or JWKS failure
  usually means the browser-facing Keycloak URL does not resolve inside the cluster: set
  `keycloak.internalUrl`.
- **The API pod is not ready (`/api/v1/readyz` returns `503`).** The response marks the
  failing check: `kubernetes` (the API server is unreachable or the ServiceAccount lacks
  access) or `jwks` (Keycloak's JWKS endpoint is unreachable from the pod).
- **`403 namespace "x" is not available for apps`.** Only namespaces in
  `api.allowedNamespaces` (or, when that is empty, labeled `nebari.dev/managed=true`) can host
  apps; `default` and `kube-*` never can.
- **`403 you do not have access to app …`.** Apps are visible to their owner, their
  managers (`access.managers`) and members of `api.adminGroups` only. A manager group counts
  once the user's access token carries it (sign out and in, or wait for it to refresh).
- **`403 only the owner or an admin can change who manages this app`.** A manager edited
  `access.managers`; leave it out of the request (or send it unchanged).
- **An app's CPU and memory cards say "Metrics unavailable".** Pod CPU and memory come from
  `metrics.k8s.io`; install metrics-server.

## Install and upgrade

- **`helm install` fails with `insecureAllowAnonymous`.** The chart refuses
  `api.auth.enabled=false` on a TLS install. That combination is for local clusters; see
  [Configuration](/configuration/).
- **`helm install` fails creating a RoleBinding: namespace not found.** Every namespace in
  `api.allowedNamespaces` must exist first (`kubectl create namespace apps`).
- **A new App field is silently dropped after an upgrade.** `helm upgrade` does not update
  CRDs; re-apply them. See [Upgrading](/upgrading/).
- **Pods run old images from a source install.** A chart from a checkout defaults its image
  tags to `appVersion`; set `*.image.tag=latest` on `main`, or install a released chart.

## The MCP server

- **Every tool says to call `authenticate`.** Call it and finish the device login in the
  browser; the session expires after `MCP_SESSION_TTL_SECONDS` (8 hours by default).
- **`authenticate` fails with a TLS error.** The MCP pod could not verify Keycloak's
  certificate (common with self-signed certificates on local clusters).
- **`remove_app` does nothing.** It requires `confirm=true`.
