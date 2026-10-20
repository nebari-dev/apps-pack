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
| `runtime` | [AppRuntime](#specruntime) | No | Process configuration: env, resources, replicas. |
| `access` | [AppAccess](#specaccess) | Yes | Who can reach the app and at which subdomain. |
| `landingPage` | [AppLandingPage](#speclandingpage) | No | Whether the app gets a tile on the Nebari landing page. |

## spec.source

| Field | Type | Required | Description |
|---|---|---|---|
| `type` | string | Yes | `git` \| `inline` \| `pvc`. Exactly one matching payload field must be set. |
| `inline` | [InlineSource](#inlinesource) | For `inline` | Small content carried in the CR. |
| `git` | [GitSource](#gitsource) | For `git` | Content cloned from a git repository. |
| `pvc` | [PVCSource](#pvcsource) | For `pvc` | Content already present on a PersistentVolumeClaim. |

The source is independent of the app **kind**: without `runtime.pixiTask` the content is
served statically by nginx; with it, the content is a pixi project run as a Python app.

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

## spec.runtime

| Field | Type | Required | Default | Description |
|---|---|---|---|---|
| `env` | [][EnvVar](https://kubernetes.io/docs/reference/kubernetes-api/workload-resources/pod-v1/#environment-variables) | No | — | Environment variables. |
| `resources` | [ResourceRequirements](https://kubernetes.io/docs/concepts/configuration/manage-resources-containers/) | No | chart `apps.defaultResources` | CPU/memory requests and limits. Any cpu/memory request or limit left unset is filled from the cluster default for the app kind (static or Python); a filled limit never drops below the App's own request. Init containers get the same bounds. |
| `replicas` | int | No | `1` | Desired replicas, `0`–`10`. `0` stops the app (phase `Stopped`). |
| `keepAlive` | bool | No | `false` | Reserved for scale-to-zero idle reaping (not yet implemented). |
| `pixiTask` | string | No | — | When set, the app runs as a **Python/pixi service**: the operator copies the source into a writable workspace, runs `pixi install` (`--locked` when a `pixi.lock` is present), then `pixi run <pixiTask>`. The task must start a server on `0.0.0.0:$PORT` (`PORT` and `HOME=/app` are injected; `PORT` is 8080, or 8081 when `access.groups` or `access.users` puts the authz sidecar on 8080). Max 64 chars. |

## spec.access

| Field | Type | Required | Description |
|---|---|---|---|
| `public` | bool | No | `true` disables authentication entirely (anonymous access). |
| `groups` | []string | No | Keycloak groups allowed to open a private app. **Enforced in the app pod** by the authz sidecar (everyone else gets `403`); also passed to the `NebariApp` as `auth.groups`, which hides the landing-page tile from non-members. A user in **any** group **or** listed in `users` gets in; with both empty, any signed-in realm user does. Changes apply when the user's access token refreshes (Keycloak's lifespan, 5 minutes by default). See [Access control](/launching-apps/#access-control). |
| `users` | []string | No | Keycloak usernames (`preferred_username`, case-insensitive) allowed to open a private app, in addition to the members of `groups`. Enforced in the app pod like `groups`. Not passed to the `NebariApp` (it has no per-user rule), so it does not affect landing-page visibility. |
| `subdomain` | string | Yes | Lowercase DNS label, at most 63 characters. The app is served at `https://<subdomain>.<appsDomain>`. **Unique across all Apps** in the cluster: the API returns `409` for a taken subdomain, and if two Apps claim one anyway (e.g. via `kubectl`), the oldest keeps it and the other goes `Failed` with `Validated=False`, reason `SubdomainTaken`, and no `NebariApp`. **Immutable** after creation. The operator mirrors it into the `apps.nebari.dev/subdomain` label. |

## spec.landingPage

| Field | Type | Required | Description |
|---|---|---|---|
| `enabled` | bool | No | `true` registers the app as a tile on the Nebari landing page (name, description and thumbnail come from the spec); `false` hides it. **Unset follows the cluster default** — the chart's `apps.landingPage.enabled`, which is `false` out of the box. The app is reachable at its URL and listed in the Apps UI regardless. |

## status

| Field | Type | Description |
|---|---|---|
| `phase` | string | `Pending` \| `Deploying` \| `Running` \| `Failed` \| `Stopped`. |
| `url` | string | Where the app is (or will be) reachable. |
| `replicas` | object | `{desired, ready}` counts from the Deployment. |
| `conditions` | []Condition | See below. |
| `observedGeneration` | int64 | Last `metadata.generation` the operator processed. |
| `message` | string | Human-readable summary. |

### Conditions

| Condition | Meaning |
|---|---|
| `Validated` | The spec is coherent and the namespace is opted in. `False` with reason `ValidationFailed` is terminal until the spec changes. |
| `WorkloadReady` | The Deployment has rolled out the current pod template and all desired replicas are ready. `False` with reason `RollingOut` while pods of an older template remain (after an edit or a restart), so a `Running` app goes back to `Deploying` until the new pods are serving. |
| `RoutingReady` | Mirrors the child `NebariApp`'s `Ready` condition (routing, TLS, auth). |

Each condition's `observedGeneration` is the App generation that set it. When validation fails the operator stops before re-checking the workload and routing, so those two keep the generation they were last evaluated at until the spec is valid again.

## Children

For each `App` the operator creates (and owns, via `ownerReferences`):

| Child | Name | Purpose |
|---|---|---|
| ConfigMap | `app-<name>-content` | Inline source files (inline apps only). |
| ConfigMap | `app-<name>-server` | The nginx server config with security headers (static apps only). |
| Deployment | `app-<name>` | The app workload (hardened: non-root, no privilege escalation, seccomp `RuntimeDefault`). The `app` container comes first; an App that lists `access.groups` or `access.users` also gets the `authz` sidecar on 8080, with the app on 8081. |
| Service | `app-<name>` | ClusterIP on port 8080 (the app, or the authz sidecar in front of it). |
| NebariApp | `app-<name>` | Routing + TLS + auth + (opt-in) landing-page tile, reconciled by the nebari-operator (contract pinned to `%NEBARI_OPERATOR_VERSION%`). |

Deleting the `App` cascades through all of them.

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
