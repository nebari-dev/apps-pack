---
title: App CRD Reference
---

Complete field-by-field reference for the `App` custom resource.

**API Version:** `apps.nebari.dev/v1alpha1`
**Kind:** `App`
**Scope:** Namespaced — the namespace must be labeled `nebari.dev/managed=true`.
**Source:** [operator/api/v1alpha1/app_types.go](https://github.com/nebari-dev/apps-pack/blob/main/operator/api/v1alpha1/app_types.go)

## Full example

```yaml
apiVersion: apps.nebari.dev/v1alpha1
kind: App
metadata:
  name: team-site
  namespace: team-analytics
  labels:
    apps.nebari.dev/owner: jdoe
spec:
  displayName: "Team Site"
  description: "The team's documentation site"
  owner: jdoe
  source:
    type: git
    git:
      url: https://github.com/org/site
      ref: main
      subdir: public
  runtime:
    replicas: 1
    env:
      - name: LOG_LEVEL
        value: info
    secretKeys:            # names only; values live in the Secret app-team-site-secrets
      - DATABASE_URL
    resources:
      requests: { cpu: 250m, memory: 512Mi }
      limits:   { cpu: "1",  memory: 1Gi }
  access:
    public: false
    groups: ["analytics"]
    subdomain: team-site
  landingPage:
    enabled: true          # optional; omit to follow the cluster default (off)
status:
  phase: Running
  url: https://team-site.apps.example.ai
  replicas: { desired: 1, ready: 1 }
  conditions: [ ... ]
  message: all replicas ready
```

## spec

| Field | Type | Required | Description |
|---|---|---|---|
| `displayName` | string | Yes | Human-readable name (max 64 chars); shown in the UI and on the landing page. |
| `description` | string | No | Short description (max 256 chars). |
| `thumbnail` | string | No | Data-URI image for catalogs / the landing-page tile. |
| `owner` | string | No | Keycloak `preferred_username` that manages the app. The API sets this from the caller's token. It is the owner of record; the API also writes it to the `apps.nebari.dev/owner` label when the name is a valid label value (an email-style username such as `a@b.c` gets no label). |
| `source` | [AppSource](#specsource) | Yes | Where the app's content comes from. |
| `runtime` | [AppRuntime](#specruntime) | No | Process configuration: env, secret keys, resources, replicas. |
| `access` | [AppAccess](#specaccess) | Yes | Who can reach the app and at which subdomain. |
| `landingPage` | [AppLandingPage](#speclandingpage) | No | Whether the app gets a tile on the Nebari landing page. |

## spec.source

| Field | Type | Required | Description |
|---|---|---|---|
| `type` | string | Yes | `git` \| `inline` \| `pvc` \| `image`. Exactly one matching payload field must be set (the CRD requires `image` for `type: image`). |
| `inline` | [InlineSource](#inlinesource) | For `inline` | Small content carried in the CR. |
| `git` | [GitSource](#gitsource) | For `git` | Content cloned from a git repository. |
| `pvc` | [PVCSource](#pvcsource) | For `pvc` | Content already present on a PersistentVolumeClaim. |
| `image` | [ImageSource](#imagesource) | For `image` | A prebuilt container image, run as the app container. |

For `git`, `inline` and `pvc` the source is independent of the app **kind**: without
`runtime.pixiTask` the content is served statically by nginx; with it, the content is a pixi
project run as a Python app. An `image` source runs its own server, so it cannot be combined
with `runtime.pixiTask`.

### InlineSource

| Field | Type | Required | Description |
|---|---|---|---|
| `files` | map[string]string | Yes | Relative file paths → contents (nested paths like `pkg/mod.py` are supported). Materialized as a ConfigMap-backed volume. Keep under ~900KB total (ConfigMap limit). Paths must be relative and must not contain `..`. |

### GitSource

| Field | Type | Required | Default | Description |
|---|---|---|---|---|
| `url` | string | Yes | — | Public `https://` git repository URL. Rejected (API `422`, operator `Failed`): any other scheme, embedded credentials (`user:token@`), a leading `-`, and cluster-internal or private hosts (IP literals in private/loopback/link-local ranges, `localhost`, single-label names, `*.svc`, `*.cluster.local`, `*.internal`, `*.local`). Private repositories are not supported yet. |
| `ref` | string | No | `main` | Branch or tag (cloned with `git clone --branch`, so a commit SHA does not work). Must not start with `-`. |
| `subdir` | string | No | repo root | Path within the repository containing the content root. Must not contain `..`. |

The clone happens in a non-root init container at pod start; re-deploying picks up the
current state of the ref.

### PVCSource

| Field | Type | Required | Description |
|---|---|---|---|
| `claimName` | string | Yes | Name of an existing PersistentVolumeClaim in the app's namespace. The claim must be labeled `apps.nebari.dev/mountable=true` (its owner's opt-in); otherwise the App is `Failed` with `Validated=False`. Adding the label later re-validates the App. |
| `subPath` | string | No | Sub-path within the volume to serve. |

### ImageSource

Runs a published container image instead of serving or building content. **Off by default:**
the cluster must allow the image's registry in the chart's `apps.image.allowedRegistries`
(see [Image registries](/configuration/#image-registries)); with an empty allowlist every
image App is refused.

| Field | Type | Required | Description |
|---|---|---|---|
| `reference` | string | Yes | The image, with a **tag or a digest**: `ghcr.io/org/app:1.2.3`, `ghcr.io/org/app@sha256:<64 hex>`, or both. An implicit `:latest` is refused. Docker Hub short names are expanded the way the container runtime does (`nginx:1.27` is `docker.io/library/nginx:1.27`; `index.docker.io` is `docker.io`), and the pod runs that normalized reference, so the kubelet pulls exactly what was checked. Max 512 chars. See [allowlist matching](#image-allowlist-matching). |
| `port` | int | Yes | The port the image's server listens on (on `0.0.0.0` or `127.0.0.1`), `1024`–`65535`, not `8080` or `8082`: the `authz` sidecar always fronts image Apps on 8080 and serves its probes on 8082. Also passed to the container as `$PORT`. |
| `command` | []string | No | Replaces the image's `ENTRYPOINT` (exec form, no shell), at most 64 entries of 4096 chars. |
| `args` | []string | No | Replaces the image's `CMD` (exec form, no shell), same bounds. |
| `runAsUser` | int64 | No | A non-zero uid to run as. Set it for an image whose `USER` is a name rather than a number, which the kubelet cannot verify as non-root. `0` is refused. |

The pod keeps the invariants of every other App: `runAsNonRoot`, seccomp `RuntimeDefault`, no
privilege escalation, every capability dropped, no ServiceAccount token, and cpu/memory
limits (the chart's `apps.defaultResources.python` fills what `runtime.resources` leaves
unset). The root filesystem stays writable, as for the other app containers. `runtime.env`
and `runtime.secretKeys` work as for any App, with the same `valueFrom` restrictions.

- **Root images.** The operator never relaxes `runAsNonRoot`. An image whose `USER` is root
  (or a name) cannot start: the App goes `Failed` with `WorkloadReady=False`, reason
  `ImageRunsAsRoot`, a message that says how to fix it (rebuild with a numeric non-root
  `USER`, or set `runAsUser`), and a Warning event.
- **Pull failures.** `ErrImagePull`, `ImagePullBackOff` and `InvalidImageName` turn into
  `Failed` with reason `ImagePullFailed` and the kubelet's message (truncated).
- **Pull policy.** A tag is pulled on every pod start (`imagePullPolicy: Always`: a moved tag
  is picked up on restart, and the registry re-checks the pull credentials); a digest is
  immutable and pulled once per node (`IfNotPresent`). Pin a digest for reproducible
  deployments.
- **Private registries.** Pods pull with the Secrets named in the chart's
  `apps.image.pullSecrets`, which must exist in each App namespace.
- **Outside the allowlist.** The operator checks every App, however it was written (UI, API,
  MCP, `kubectl`, GitOps): an image outside the allowlist (or any image while it is empty) is
  `Failed` with `Validated=False`, reason `ImageNotAllowed`, a Warning event, and its
  Deployment is **scaled to zero**, so removing a registry from the allowlist stops the Apps
  that use it once the operator restarts with the new list. apps-api refuses the same images
  with a `422`.

#### Image allowlist matching

Each entry is `<registry host>[:port][/<repository prefix>]`, normalized like references
(lowercase host, `docker.io` for Docker Hub's aliases). An image matches when its normalized
`<host>/<repository>` **equals** an entry or **continues it with `/`**:

| Entry | Allows | Does not allow |
|---|---|---|
| `ghcr.io/org` | `ghcr.io/org/app:1`, `ghcr.io/org/team/app:1` | `ghcr.io/org-evil/app:1`, `ghcr.io/other/app:1`, `ghcr.io.evil.com/org/app:1` |
| `docker.io/library` | `nginx:1.27`, `docker.io/library/redis:7` | `bitnami/nginx:1` (that is `docker.io/bitnami/nginx`) |
| `quay.io` | anything on `quay.io` | `sub.quay.io/…`, `quay.io.example.net/…` |
| `registry.example.com:5000` | `registry.example.com:5000/x/y:1` | `registry.example.com/x/y:1` (the port is part of the host) |

Hosts compare whole and prefixes compare whole path components; there are no wildcards. An
entry must start with a host (`docker.io`, not `library`) and carries no tag or digest; the
operator and apps-api refuse to start with a malformed one.

## spec.runtime

| Field | Type | Required | Default | Description |
|---|---|---|---|---|
| `env` | [][EnvVar](https://kubernetes.io/docs/reference/kubernetes-api/workload-resources/pod-v1/#environment-variables) | No | — | Plain environment variables, at most 256. Their values are stored in the App and shown to everyone who can read it (`kubectl get app`, `GET /apps`, MCP tools): never put credentials here, use `secretKeys`. The kubelet resolves `valueFrom` with its own rights, so references that would read other Apps' data are refused: **no `valueFrom.secretKeyRef`** (the CRD rejects it; use `secretKeys`), and no `configMapKeyRef` to another App's generated ConfigMap (`app-<other>-content`, `app-<other>-server`). The operator also checks both, so an App stored before these rules goes `Failed` with `Validated=False`, reason `ForbiddenEnvReference` (plus a Warning event), and its workload is not created or updated. `fieldRef`, `resourceFieldRef`, `fileKeyRef` and other `configMapKeyRef`s are allowed. |
| `secretKeys` | []string | No | — | Names of keys in the App's Secret, `app-<name>-secrets` in its namespace, each injected into the `app` container as an environment variable of the same name (`valueFrom.secretKeyRef`). Names must be environment variable names (`^[A-Za-z_][A-Za-z0-9_]*$`, max 128 chars), unique, at most 64. The App holds only the names: apps-api writes the values and keeps this list in step (it ignores a list sent without values); GitOps can create the Secret itself. Until the Secret and each listed key exist the container does not start (`CreateContainerConfigError`). A changed `apps.nebari.dev/secrets-version` annotation on the App rolls the pods. See [Secrets](#secrets). |
| `resources` | [ResourceRequirements](https://kubernetes.io/docs/concepts/configuration/manage-resources-containers/) | No | chart `apps.defaultResources` | CPU/memory requests and limits. Any cpu/memory request or limit left unset is filled from the cluster default for the app kind (static, or Python for pixi and image apps); a filled limit never drops below the App's own request. Init containers get the same bounds. |
| `replicas` | int | No | `1` | Desired replicas, `0`–`10`. `0` stops the app (phase `Stopped`). |
| `keepAlive` | bool | No | `false` | `true` exempts the app from [scale to zero](#scale-to-zero): it keeps running however long it goes without a request, whatever `idleTimeoutMinutes` or the cluster default say. |
| `idleTimeoutMinutes` | int | No | chart `apps.idle.timeoutMinutes` | Minutes without a request before the operator scales the app to zero (phase `Idle`), `5`–`43200`. Unset follows the cluster default (`0` there keeps apps running), so an App can opt in on a cluster that does not idle by default. Ignored when `keepAlive` is `true` or `replicas` is `0`. See [Scale to zero](#scale-to-zero). |
| `pixiTask` | string | No | — | Not allowed with `source.type: image`. When set, the app runs as a **Python/pixi service**: the operator copies the source into a writable workspace, runs `pixi install` (`--locked` when a `pixi.lock` is present), then `pixi run <pixiTask>`. The task must start a server on `0.0.0.0:$PORT` (`PORT` and `HOME=/app` are injected; `PORT` is 8080, or 8081 when the sidecar takes 8080: `access.groups` is set, or the app can idle). Max 64 chars. |

## spec.access

| Field | Type | Required | Description |
|---|---|---|---|
| `public` | bool | No | `true` disables authentication entirely (anonymous access). |
| `groups` | []string | No | Keycloak groups allowed to open a private app. **Enforced in the app pod** by the authz sidecar (everyone else gets `403`); also passed to the `NebariApp` as `auth.groups`, which hides the landing-page tile from non-members. A user in **any** group gets in; with none listed, any signed-in realm user does. Access is by group only: to let one person in, add them to a group. Changes apply when the user's access token refreshes (Keycloak's lifespan, 5 minutes by default). See [Access control](/launching-apps/#access-control). |
| `managers.users` | []string | No | Keycloak usernames (`preferred_username`, case-insensitive) who may **manage** the app through apps-api, the UI and the MCP server: everything its owner can do (edit, stop, start, restart, delete, read status, logs, events and metrics) except change `managers`. Only the owner and `api.adminGroups` members may change the list. Does **not** let them open a restricted app: that is still `public` and `groups`. Ignored by the operator. See [Managers](/launching-apps/#managers). |
| `managers.groups` | []string | No | Keycloak groups whose members may manage the app, like `managers.users`. Membership is read from the caller's verified access token (a leading `/` is ignored), the same way `api.adminGroups` is checked, so a group change applies when their token refreshes. |
| `subdomain` | string | Yes | Lowercase DNS label, at most 63 characters. The app is served at `https://<subdomain>.<appsDomain>`. **Unique across all Apps** in the cluster: the API returns `409` for a taken subdomain, and if two Apps claim one anyway (e.g. via `kubectl`), the oldest keeps it and the other goes `Failed` with `Validated=False`, reason `SubdomainTaken`, and no `NebariApp`. **Immutable** after creation. The operator mirrors it into the `apps.nebari.dev/subdomain` label. |

## spec.landingPage

| Field | Type | Required | Description |
|---|---|---|---|
| `enabled` | bool | No | `true` registers the app as a tile on the Nebari landing page (name, description and thumbnail come from the spec); `false` hides it. **Unset follows the cluster default** — the chart's `apps.landingPage.enabled`, which is `false` out of the box. The app is reachable at its URL and listed in the Apps UI regardless. |

## status

| Field | Type | Description |
|---|---|---|
| `phase` | string | `Pending` \| `Deploying` \| `Running` \| `Failed` \| `Stopped` \| `Idle`. `Stopped` means `replicas: 0` in the spec; `Idle` means the operator scaled the app to zero after its idle timeout, and the next request to its URL starts it again (it goes `Deploying`, then `Running`). |
| `url` | string | Where the app is (or will be) reachable. |
| `replicas` | object | `{desired, ready}` counts from the Deployment. |
| `conditions` | []Condition | See below. |
| `observedGeneration` | int64 | Last `metadata.generation` the operator processed. |
| `message` | string | Human-readable summary. |
| `lastActivityTime` | time | When the app last served a request, as far as the operator knows (it asks the app pod's sidecar every few minutes). Set only for apps that can idle; shown by `kubectl get apps -o wide` as **Last Active**. |

### Conditions

| Condition | Meaning |
|---|---|
| `Validated` | The spec is coherent and the namespace is opted in. `False` with reason `ValidationFailed` is terminal until the spec changes; `ImageNotAllowed` means an image source outside the registry allowlist (its Deployment is scaled to zero). |
| `WorkloadReady` | The Deployment has rolled out the current pod template and all desired replicas are ready. `False` with reason `RollingOut` while pods of an older template remain (after an edit or a restart), so a `Running` app goes back to `Deploying` until the new pods are serving. For image apps, `ImageRunsAsRoot` and `ImagePullFailed` mean the kubelet cannot start the image (phase `Failed`). |
| `RoutingReady` | Mirrors the child `NebariApp`'s `Ready` condition (routing, TLS, auth). |

Each condition's `observedGeneration` is the App generation that set it. When validation fails the operator stops before re-checking the workload and routing, so those two keep the generation they were last evaluated at until the spec is valid again.

## Children

For each `App` the operator creates (and owns, via `ownerReferences`):

| Child | Name | Purpose |
|---|---|---|
| ConfigMap | `app-<name>-content` | Inline source files (inline apps only). |
| ConfigMap | `app-<name>-server` | The nginx server config with security headers (static apps only). |
| Deployment | `app-<name>` | The app workload (hardened: non-root, no privilege escalation, seccomp `RuntimeDefault`). The `app` container comes first; an App that lists `access.groups`, that can idle, or that runs an image also gets the `authz` sidecar on 8080, with the app on 8081 (an image app on its own `source.image.port`). For an unrestricted App the sidecar runs in passthrough mode and only records activity. Scaled to zero while the App is `Idle`. |
| Service | `app-<name>` | ClusterIP on port 8080 (the app, or the authz sidecar in front of it). |
| NebariApp | `app-<name>` | Routing + TLS + auth + (opt-in) landing-page tile, reconciled by the nebari-operator (contract pinned to `%NEBARI_OPERATOR_VERSION%`). While the App is `Idle` or waking, `spec.service` points at the activator Service in the pack's namespace. |

Deleting the `App` cascades through all of them, and through the App's Secret
(`app-<name>-secrets`), which apps-api creates with an owner reference to the App when
secret values are first set.

## Secrets

Credentials never go in the App. `runtime.secretKeys` lists names; the values live in the
Secret `app-<name>-secrets` in the App's namespace:

- **Through apps-api** (UI, REST, MCP), send values in `secrets` on launch or edit, or with
  `PATCH /apps/{ns}/{name}/secrets` (`{"NAME": "value"}` sets or rotates, `{"NAME": null}`
  removes). apps-api writes the Secret (owned by the App), updates `secretKeys`, and sets the
  `apps.nebari.dev/secrets-version` annotation to the Secret's `resourceVersion`, which the
  operator copies to the pod template so the pods restart with the new values. No response
  ever includes a value.
- **With kubectl or GitOps**, create the Secret yourself and list its keys:

  ```bash
  kubectl -n team-analytics create secret generic app-team-site-secrets \
    --from-literal=DATABASE_URL='postgres://…'
  ```

  It is not owned by the App unless you add the owner reference, so it outlives the App.
  After changing a value, roll the pods with `kubectl rollout restart deployment/app-team-site`
  (or change the annotation).

The name is fixed by the App's name, so an App's pods only ever reference their own Secret,
and app pods have no ServiceAccount token to read others. `runtime.env` cannot name a Secret
(`valueFrom.secretKeyRef` is refused by the CRD, apps-api and the operator), which would
otherwise let anyone who can write an App read any Secret in its namespace through the kubelet.

## Scale to zero

An App **can idle** when its idle timeout (`runtime.idleTimeoutMinutes`, else the chart's
`apps.idle.timeoutMinutes`) is above zero, `runtime.keepAlive` is not `true` and
`runtime.replicas` is not `0`. Such an App runs the `authz` sidecar, which records when the app
last served a request; a request still open (a WebSocket, a stream) counts until it ends, and
requests the sidecar refuses (`401`/`403`) do not count. The operator asks every ready pod's
sidecar every few minutes (a sixth of the timeout, between 30 seconds and 5 minutes) and keeps
the answer in `status.lastActivityTime`.

1. Once the App has gone a whole timeout without a request, the operator scales the Deployment
   to zero and the phase becomes `Idle`. The App's spec, including `replicas`, is unchanged.
2. Its `NebariApp` now routes to the **activator**: a page served by the operator itself (behind
   the `<release>-activator` Service) that says the app is starting, reloads itself every few
   seconds, and answers `503` with `Retry-After` for non-browser clients. Sign-in at the gateway
   still applies to private apps.
3. The request stamps the `apps.nebari.dev/wake-requested-at` annotation on the App, which counts
   as a request: the operator scales the Deployment back to `replicas` (phase `Deploying`,
   message "waking up"). Starting the App from the UI, the API or the `start_app` tool sets the
   same annotation.
4. When a pod is ready, routing moves back to the App's Service and the next reload reaches the
   app. A cold start takes a few seconds for a static app; a Python app reinstalls its pixi
   environment, which can take minutes.

If the operator cannot read a pod's activity (a NetworkPolicy blocking it, an old pod without
the sidecar), it keeps the App running and asks again at the next poll: an App is never idled
because the operator could not see it working. A failed check is not a request, so
`status.lastActivityTime` stays where it was, and once the check works again the App idles on
its real last request. An `Idle` App stays idle until a request wakes it: the operator does not
ask its pods while they shut down. A newly idling App (just launched, or idling just turned on) starts its clock
then. Turning `keepAlive` on, or idling on or off, rolls the App's pods, because the sidecar is
added or removed.

## Versioning and deprecation

`apps.nebari.dev/v1alpha1` is the only version, served and stored. Apps are the pack's only
state, so a CRD change must never force anyone to delete and re-create them.

**Within a version, changes are additive only.** A release may add optional fields, add enum
values, and loosen validation. It never removes, renames or retypes a field, makes an
existing field required, removes an enum value, or changes what an existing value means. The
"CRD stays compatible with stored Apps" check in CI compares every PR's CRD with the base
branch and fails on any of those.

**Tightening validation** (a new bound, pattern or CEL rule, such as the 10-replica cap or the
immutable subdomain) is allowed but called out: Kubernetes
[validation ratcheting](https://kubernetes.io/docs/tasks/extend-kubernetes/custom-resources/custom-resource-definitions/#validation-ratcheting)
lets an App that was valid before keep accepting updates that leave the offending field
alone, and the CI check prints a warning so the change lands in the CHANGELOG and
[Upgrading](/upgrading/#version-notes).

**Deprecating a field.** Its description in the CRD and this page say so and name the
replacement; it keeps working for at least two minor releases after the release that
deprecates it, and the CHANGELOG lists the removal ahead of time.

**A breaking change gets a new version.** The plan, when one is needed:

1. Release N adds the new version (`v1beta1`, then `v1`) alongside `v1alpha1`. Both are
   served; `v1alpha1` stays the storage version. apps-operator serves a conversion webhook
   (controller-runtime's hub-and-spoke conversion, with the newest version as the hub), and
   the chart wires it into the CRD's `spec.conversion`. Clients can move to the new version
   at their own pace; GitOps manifests in either version keep applying.
2. Release N+1 makes the new version the storage version. The operator re-writes every App
   once so etcd holds only the new version, then `status.storedVersions` is trimmed to it.
   `v1alpha1` is marked `deprecated: true` with a `deprecationWarning` that `kubectl`
   prints on every use.
3. `v1alpha1` stays served for at least two minor releases after N+1, then is set to
   `served: false`, and is removed in a later release.

Before this policy (up to 0.1.0) the schema changed shape in place twice; the
[CHANGELOG](https://github.com/nebari-dev/apps-pack/blob/main/CHANGELOG.md) and
[Upgrading](/upgrading/#version-notes) cover what that means for existing Apps.
