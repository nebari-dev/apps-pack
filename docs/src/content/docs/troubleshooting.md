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
| reason `ImageNotAllowed`: `image sources are disabled on this cluster …` or `… is not in the allowed image registries (…)` | The image's registry (after normalization: `nginx:1.27` is `docker.io/library/nginx`) is not in `apps.image.allowedRegistries`. Use an allowed image, or ask an admin to allow it. The operator scales the App's Deployment to zero until it is fixed. |
| `source.image.reference "…": needs a tag (:1.2.3) or a digest (@sha256:...)` | Add a tag or digest; an implicit `:latest` is refused. |
| `source.image.port … must be 1024-65535 and not 8080 or 8082` | Make the image listen on another port (most accept `$PORT` or a flag) and set `port` to it. |

- **`ForbiddenEnvReference`.** `runtime.env` uses `valueFrom.secretKeyRef`, or a
  `configMapKeyRef` to another App's `app-<name>-content`/`app-<name>-server`. Those would
  read data that is not the App's own, so the operator refuses the workload (it is not
  created or updated; `kubectl describe app <name>` shows the Warning event). Move credentials
  to `runtime.secretKeys` (values in `app-<name>-secrets`, or set them in the UI's
  **Secrets**) and remove the reference.

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
  that can idle gets `PORT=8081`, because the authz sidecar takes 8080: a task that
  hard-codes 8080 then collides with the sidecar.
- **A restricted app returns `403` to someone who should get in.** The gateway refused them:
  their access token's `groups` claim holds none of the App's `access.groups`. Entries are
  full group paths matched exactly and case-sensitively, so `/finance` does not admit someone
  who is only in `/finance/analysts`: list the subgroup itself. Group changes reach the token
  on its next refresh (5 minutes by default); someone just added should sign out and back in.
  The values the gateway enforces are in the SecurityPolicy:
  `kubectl -n <ns> get securitypolicy app-<name>-security -o jsonpath='{.spec.authorization}'`.
  nebari-operator's [troubleshooting guide](https://github.com/nebari-dev/nebari-operator/blob/main/docs/troubleshooting.md)
  covers the rest.
- **Every signed-in user gets into a restricted app.** nebari-operator is older than
  `%NEBARI_OPERATOR_VERSION%`, which is the first release that enforces `auth.groups` at the
  gateway: upgrade it ([Upgrading](/upgrading/)). The SecurityPolicy above has no
  `authorization` section then.
- **A restricted app stays `Deploying` with `GroupsNotResolved` in `RoutingReady`.** A path in
  `access.groups` (such as `/ops/oncall`) does not exist in Keycloak. Paths are never created:
  create the group, or list a top-level group by bare name (`oncall`) to have nebari-operator
  create it. `GroupsEmpty` means every entry names no group (such as `/`), and
  `GroupsClaimConflict` that a mapper on the app's Keycloak client writes the `groups` claim
  in another form; the gateway denies everyone until it is fixed.
- **An app pod's `authz` container exits with "AUTHZ_GROUPS is set".** The authz image is
  newer than the apps-operator, which still asks the sidecar to check groups. The sidecar
  refuses rather than run the App open: upgrade the operator to the same release as the
  image (the chart ships them together).
- **An image app stays `Failed` with "--authz-image".** Image apps always run the sidecar:
  keep the chart's `authz.image`.
- **`CreateContainerConfigError` with `secret "app-<name>-secrets" not found` or
  `couldn't find key`.** The App lists `runtime.secretKeys` that its Secret does not hold.
  Set the missing values (UI **Secrets**, `PATCH /apps/{ns}/{name}/secrets`), or, for an App
  managed with kubectl, create the Secret or remove the name from `secretKeys`. Right after
  a launch with secrets this clears by itself within seconds, once apps-api has written the
  Secret.
- **A rotated secret has no effect.** Pods read environment variables at start. apps-api
  rolls them on every write; after editing the Secret with kubectl, run
  `kubectl -n <ns> rollout restart deployment/app-<name>`.
- **Image app `Failed` with reason `ImageRunsAsRoot`.** The image's `USER` is root (or a name
  the kubelet cannot check), and app pods must run as non-root. Rebuild the image with a
  numeric non-root `USER` (e.g. `USER 1000`, owning the directories the app writes), or set
  `source.image.runAsUser` to the uid of the image's named user. The policy is never relaxed.
- **Image app `Failed` with reason `ImagePullFailed`.** Check `source.image.reference`; for a
  private registry the Secret named in `apps.image.pullSecrets` must exist in the App's
  namespace and grant access (`kubectl -n <ns> describe pod -l apps.nebari.dev/app=<name>`
  shows the registry's answer).
- **Image app `Running` but never ready, or `CrashLoopBackOff`.** The server must listen on
  `source.image.port` (on `0.0.0.0` or `127.0.0.1`): readiness goes through the sidecar, which
  dials that port. An image that writes to its home or a root-owned directory may fail as a
  non-root user; point its cache or home at `/tmp` with an environment variable.
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
- **An app's Resources card says "Live usage needs metrics-server".** Live CPU and memory
  usage come from `metrics.k8s.io`; install metrics-server. Limits and restarts come from the
  pods and show either way.

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

- **Claude Code shows the server as needing authentication.** Run `/mcp`, select it and
  choose **Authenticate**, or `claude mcp login nebari-apps`.
- **The browser login fails with "Invalid parameter: redirect_uri".** The `--callback-port`
  (or `oauth.callbackPort`) does not match the client's redirect URI in Keycloak, or the
  server was added without `--client-id`. Re-add it with the command from the UI's Settings
  page.
- **Claude Code says dynamic client registration failed.** No client id was configured, so
  it tried to register one and Keycloak refused. Add the server with `--client-id`; see
  [The sign-in client](/mcp/#the-sign-in-client).
- **Every request gets `401` with `error="invalid_token"` after signing in.** The token is
  from a client the pack does not accept (set `mcp.oauth.clientId` to the client you sign in
  with), or apps-mcp cannot fetch the realm JWKS: its log says `token rejected` with the
  reason. A TLS error there means Keycloak's certificate comes from a private CA; trust it
  with `mcp.orgCABundle` or set `keycloak.internalUrl`.
- **`remove_app` does nothing.** It requires `confirm=true`.
