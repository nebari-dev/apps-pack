---
title: Upgrading
description: Upgrade the chart safely - back up App resources, re-apply the CRD, and roll back.
---

## Before you upgrade

**Back up the App resources.** Apps are the only state the pack owns; every Deployment,
Service, ConfigMap and NebariApp is re-created from them.

```bash
kubectl get apps -A -o yaml > apps-backup-$(date +%F).yaml
```

Inline sources live inside the App, so the backup restores them too. Git sources re-clone
on restore. Data on a PersistentVolumeClaim (`pvc` sources) is not in the App: back up the
claim with your usual volume tooling.

Read the [CHANGELOG](https://github.com/nebari-dev/apps-pack/blob/main/CHANGELOG.md) for
the versions you are skipping; behavior changes are listed there.

## Upgrade with Helm

`helm upgrade` installs a CRD only on first install and **never updates it**, so apply the
new chart's CRD first, then upgrade:

```bash
VERSION=<X.Y.Z>
helm show crds oci://ghcr.io/nebari-dev/apps-pack/charts/nebari-apps --version "$VERSION" \
  | kubectl apply --server-side --force-conflicts -f -
helm upgrade nebari-apps oci://ghcr.io/nebari-dev/apps-pack/charts/nebari-apps \
  --version "$VERSION" --namespace nebari-apps --reuse-values
```

`--force-conflicts` takes the CRD's fields over from the field manager that installed it
(Helm or Argo CD). Skipping the CRD step leaves the old schema in place: the API server then **silently drops**
any new App field, and validation the new version relies on is missing.

Upgrade the chart and images together. A released chart pins all five images to the same
build, and newer operator or API images can depend on RBAC that only the matching chart
grants.

## Upgrade with Argo CD

Bump `targetRevision` in the `Application` (see
[`examples/argocd-application.yaml`](https://github.com/nebari-dev/apps-pack/blob/main/examples/argocd-application.yaml)).
Argo CD renders the chart's `crds/` directory with the rest of the chart, so the CRD is
updated on sync. Back up the Apps first all the same.

## Check the result

```bash
kubectl -n nebari-apps rollout status deploy/nebari-apps-operator deploy/nebari-apps-api
kubectl get apps -A        # every App should return to Running
curl -s https://apps.<cluster-domain>/api/v1/version
```

The UI's **Settings** page (account menu → **Settings**) shows that version and build next to
the UI's own: the UI's version is built into its bundle and its build is the UI image tag the
chart rendered. During a rollout the two can differ for a minute, and the page says so; if
they still differ afterwards, one of the Deployments did not roll.

## Roll back

```bash
helm history nebari-apps -n nebari-apps
helm rollback nebari-apps <REVISION> -n nebari-apps
```

`helm rollback` restores the workloads, RBAC and values, but not the CRD. CRD changes
within `v1alpha1` are additive ([versioning policy](/app-crd-reference/#versioning-and-deprecation),
checked in CI), so the newer CRD keeps working with the older operator. Rolling back past
[gateway group enforcement](#upgrading-to-gateway-group-enforcement) brings the old sidecar
back, which also checks groups, so leave nebari-operator where it is. The exception is
[group-only access](#upgrading-to-group-only-access), which removed `access.users`: rolling
back does not restore the lists the newer CRD pruned.
If Apps were lost, re-apply the backup:

```bash
kubectl apply -f apps-backup-<date>.yaml
```

Status fields in the backup are ignored; the operator recomputes them.

## Version notes

### Upgrading to the proxy sidecar

**Breaking:** the sidecar in front of Apps that can idle and image Apps is renamed from
apps-authz to apps-proxy. It has checked no tokens or groups since
[gateway group enforcement](#upgrading-to-gateway-group-enforcement); it only proxies requests,
records activity for scale to zero and gives image Apps the front port 8080. Its ports and
behaviour are unchanged.

- **The image and the chart keys are renamed.** The image is now
  `ghcr.io/nebari-dev/apps-pack/proxy` (`quay.io/nebari/apps-pack-proxy`), and the chart's
  `authz.*` values are now `proxy.*` (`proxy.image.repository`, `proxy.image.tag`,
  `proxy.image.pullPolicy`, `proxy.resources`). If you override them, for example to mirror
  the images, move your settings to the new keys. The chart's schema rejects the old `authz`
  key, so a values file that still sets it fails the install instead of being ignored.
- **Pods with the sidecar roll once.** The sidecar container is now named `proxy` (and its
  probe port `proxy-health`), so every App that can idle or runs an image gets a new pod once.
- **Read its logs with `-c proxy`.** `kubectl logs -c authz` becomes `kubectl logs -c proxy`;
  the same goes for the API's and the MCP server's `container` parameter.
- **Upgrade the chart and the images together.** The operator now sets `PROXY_*` variables on
  the sidecar. A proxy image refuses to start when it is given the old `AUTHZ_*` ones (or
  `AUTHZ_GROUPS`), and an authz image does not start without them, so a mismatched operator
  and image leave the App down rather than open.

### Upgrading to the shorter image names

The images dropped their `apps-` prefix: `ghcr.io/nebari-dev/apps-pack/apps-operator` is now
`ghcr.io/nebari-dev/apps-pack/operator`, and the same for `authz` (now
[`proxy`](#upgrading-to-the-proxy-sidecar)), `api`, `ui` and `mcp`
(on Quay, `quay.io/nebari/apps-pack-operator` and so on). The chart's defaults follow, so
nothing changes unless you set `*.image.repository` yourself, for example to mirror the
images: point those values at the new names. Images built before the rename stay at the old
paths; new tags are published only under the new ones.

### Upgrading to gateway group enforcement

**Breaking:** `access.groups` are enforced at the gateway by nebari-operator
`%NEBARI_OPERATOR_VERSION%`, the first release that enforces a `NebariApp`'s `auth.groups`, and
the pack now requires it. The apps-authz sidecar no longer checks tokens or groups: it only
runs in Apps that can idle (activity for scale to zero) and in image Apps (the front port), and
a restricted App that does neither loses it. The operator's `--keycloak-url`,
`--keycloak-internal-url` and `--keycloak-realm` flags are gone; `keycloak.*` in the chart now
configures only apps-api and apps-mcp.

- **Upgrade nebari-operator first.** With an older nebari-operator the gateway ignores
  `auth.groups`, so after the pack upgrade a restricted App would be open to every signed-in
  user. Upgrade nebari-operator to `%NEBARI_OPERATOR_VERSION%` (it needs Envoy Gateway v1.2.0 or
  later), check that a restricted App's SecurityPolicy has an `authorization` section, then
  upgrade the pack:

  ```bash
  kubectl -n <ns> get securitypolicy app-<name>-security -o jsonpath='{.spec.authorization.defaultAction}{"\n"}'   # Deny
  ```

  In between, the old sidecar and the gateway both check groups, which is safe. Do not roll
  nebari-operator back below `%NEBARI_OPERATOR_VERSION%` while this pack runs.
- **Users sign in again once.** nebari-operator renames the access-token cookie of every App
  that enforces groups (`nebari-at-<namespace>-<name>`), so users of restricted Apps are signed
  out once when it starts enforcing, and every App's Keycloak client is reprovisioned once.
- **The `groups` claim now carries full paths.** nebari-operator switches every client's group
  mapper to full paths (`/finance`, `/finance/analysts`), and entries are matched as full
  paths: `finance` is the top-level group `/finance`, and `/finance` does not admit members of
  `/finance/analysts` only. Before, the claim held bare names, so an App that listed a
  subgroup by its name (`analysts` for `/finance/analysts`) let its members in. Now:
  - such an entry means a **top-level** group `/analysts`, which nebari-operator creates in
    Keycloak if it is missing, and the subgroup's members get `403`. Replace it with the full
    path (`/finance/analysts`).
  - the same holds for `access.managers.groups` and the chart's `api.adminGroups`: a subgroup
    named without its parent no longer matches. List its full path.
  - apps that read the `groups` claim themselves (with `enforceAtGateway: false`, or the pack's
    API and MCP server) see the leading `/`. apps-api and apps-mcp match full paths already.

  Find the entries to check:

  ```bash
  kubectl get apps.apps.nebari.dev -A -o json | jq -r '.items[] | select((.spec.access.groups // []) + (.spec.access.managers.groups // []) | length > 0) | "\(.metadata.namespace)/\(.metadata.name): groups=\(.spec.access.groups // []) managers=\(.spec.access.managers.groups // [])"'
  ```

- **Pods roll once.** Restricted Apps lose the sidecar unless they can idle or run an image,
  and Python tasks there move from port 8081 to 8080 (`$PORT`). Every other App with the
  sidecar rolls once for its new environment.
- **The token no longer reaches the app.** The gateway stopped forwarding the access token to
  restricted Apps (`forwardAccessToken`). An app that read `Authorization: Bearer` there gets
  no header now.
- **Keep the gateway the only way in.** The sidecar used to refuse non-members even for
  traffic from inside the cluster. Turn on `apps.networkPolicy.enabled` so app pods take
  traffic only from the gateway.
- **Mixed versions.** An authz image from this release refuses to start (`AUTHZ_GROUPS is set`)
  next to an older apps-operator, so a restricted App never runs open; upgrade the chart and
  images together.

### Upgrading to MCP OAuth

**Breaking:** MCP clients sign in themselves with standard
[MCP authorization](/mcp/#authentication): apps-mcp is an OAuth 2.0 protected resource with
the Keycloak realm as its authorization server, and it verifies the bearer token on every
request. The `authenticate` tool, the per-session device-flow token cache and
`MCP_SESSION_TTL_SECONDS` are removed.

- **Create the sign-in client before you upgrade.** On a cluster with auth on, MCP clients
  need a public Keycloak client with a loopback redirect URI, which the pack cannot
  provision. A cluster admin creates it once ([The sign-in client](/mcp/#the-sign-in-client))
  and sets `mcp.oauth.clientId` (and `mcp.oauth.callbackPort` if it is not `33418`). Until
  then MCP clients cannot sign in on their own.
- **Users reconnect their agents.** Re-add the server with the command on the UI's
  **Settings** page (`claude mcp add … --client-id <id> --callback-port <port>`), then run
  `/mcp` in Claude Code, select it and choose **Authenticate**. Agents that called the
  `authenticate` tool no longer find it.
- **Drop `MCP_SESSION_TTL_SECONDS`** from `mcp.extraEnv` if you set it; it is ignored.

### Upgrading to group-only access

**Breaking:** Apps restrict who may open them by Keycloak group only. `spec.access.users`
(the per-user allow list) is removed from the CRD, the API, the MCP `launch_app` tool, the
UI and the apps-authz sidecar (`AUTHZ_USERS`, `AUTHZ_USERS_CLAIM`).
`spec.access.managers.users`, the users who may *manage* an App, is unchanged.

- **An App that restricted only by users becomes open to every signed-in user.** The new
  CRD's structural schema prunes `access.users` from stored Apps, so an App that listed
  users and no groups is left with neither list: the operator drops its authz sidecar and
  any user who can sign in to the realm gets in. An App that listed both keeps its groups,
  and the people it let in only by username are refused (`403`).
- **Before upgrading, find the Apps that list users:**

  ```bash
  kubectl get apps.apps.nebari.dev -A -o json | jq -r '.items[] | select(.spec.access.users // [] | length > 0) | "\(.metadata.namespace)/\(.metadata.name)"'
  ```

  For each one, put those users in a Keycloak group (an existing one, or a new group per
  App) and add the group to the App's `access.groups` before you apply the new CRD. Group
  membership reaches users' tokens on their next refresh (5 minutes by default). Take the
  [backup](#before-you-upgrade) after this step too: a rollback does not bring the pruned
  lists back, the backup does.
- **Clients that still send `access.users`** get a `422` from the API (and from the upload
  route's manifest) instead of an App that is silently open to more people. Update scripts,
  `nebari-app.yaml` manifests and GitOps manifests to use groups; for GitOps and `kubectl`
  the apiserver prunes the field without an error, so check those by hand.

### Upgrading to container images

- **Re-apply the CRD first.** It adds `source.type: image` and `source.image`, plus CEL rules
  that require `source.image` for that type and keep its port off the sidecar's 8080 and
  8082. Existing Apps are unaffected.
- **Off unless you turn it on.** `apps.image.allowedRegistries` defaults to empty, which
  refuses every image App (UI, API, MCP and `kubectl` alike). Set it, and
  `apps.image.pullSecrets` for private registries, to enable the source; see
  [Image registries](/configuration/#image-registries).
- No RBAC changes: the operator only sets `imagePullSecrets` by name on the pods it already
  creates.

### Upgrading to App secrets

- **Re-apply the CRD first.** It adds `runtime.secretKeys`, caps `runtime.env` at 256
  entries, and adds a CEL rule that refuses `runtime.env[].valueFrom.secretKeyRef`.
- **Apps that read a Secret through `runtime.env` stop being served.** Before upgrading, find
  them:

  ```bash
  kubectl get apps -A -o json | jq -r '.items[] | select(any(.spec.runtime.env[]?;
    .valueFrom.secretKeyRef or (.valueFrom.configMapKeyRef.name // "" | test("^app-.*-(content|server)$"))))
    | "\(.metadata.namespace)/\(.metadata.name)"'
  ```

  Such a reference let anyone who could write an App read any Secret in its namespace, so the
  upgraded operator marks these Apps `Failed` (`Validated=False`, reason
  `ForbiddenEnvReference`, plus a Warning event) and stops updating their Deployment. Pods
  already running keep their old spec until the App is fixed, so fix them promptly. Move each
  credential into the App's own Secret, `app-<name>-secrets`, list its key in
  `runtime.secretKeys`, and drop the `valueFrom` entry. A `configMapKeyRef` to another App's
  generated ConfigMap is refused the same way; references to your own ConfigMaps are fine.
  Stored Apps stay editable as long as an edit leaves `runtime` alone; a `runtime` edit (from
  `kubectl` or the UI) must remove the reference.
- **The API's ServiceAccount can create and patch Secrets** in app namespaces (never read
  them), to store App secrets ([details](/architecture/#secrets)).

### Upgrading to scale to zero

- **Re-apply the CRD first.** It adds `runtime.idleTimeoutMinutes`, `status.lastActivityTime`
  and the `Idle` phase; an operator running against the old CRD cannot report `Idle`.
- **Off unless you turn it on.** `apps.idle.timeoutMinutes` defaults to `0`, so nothing idles
  until you set it or an App sets `runtime.idleTimeoutMinutes`. Turning it on rolls the pods of
  every App that can idle once: they gain the authz sidecar, and Python tasks there move to
  port 8081 (`$PORT`). Set `runtime.keepAlive: true` first on Apps that must stay up.
- **Gateway API `ReferenceGrant`.** Idle Apps route to the activator Service in the release
  namespace through a `ReferenceGrant` the operator creates there; the operator gains
  read-only access to pods and write access to `referencegrants` in its own namespace
  ([details](/configuration/#apps-operator)).

### 0.1.0 → 0.2.0

- **Namespaces first.** The API gets a RoleBinding in each namespace in
  `api.allowedNamespaces` (default `apps`); each must exist before the upgrade.
- **PVC sources need an opt-in.** A `pvc` App goes `Failed` until its claim is labeled
  `apps.nebari.dev/mountable=true`.
- **Subdomains are unique and immutable.** If two Apps already share a subdomain, the
  older keeps it and the other goes `Failed` (`SubdomainTaken`).
- **`access.groups` and `access.users` are enforced.** A private App that lists them gets
  the apps-authz sidecar and returns `403` to everyone else, so check who your existing
  Apps list. Python tasks of restricted Apps must listen on `$PORT` (8081 for them). The
  operator needs the chart's `keycloak.url` (or `keycloak.internalUrl`), or such Apps fail
  validation; the sidecar image (`proxy.image`) ships with the chart.
- **App pods get default requests and limits** (`apps.defaultResources`) and at most 10
  replicas.
- **Auth is stricter.** Tokens must come from the pack's own Keycloak clients, and
  `api.auth.enabled=false` is refused on TLS installs.
- **MCP:** `remove_app` needs `confirm=true`; `get_app_logs` and `list_apps` return a
  different shape.
- **Releases** are cut from a release PR and published to the org Helm repository and
  GHCR; see [CI/CD & releasing](/ci-cd/).
