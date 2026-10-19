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
| `pixiTask` | string | No | — | When set, the app runs as a **Python/pixi service**: the operator copies the source into a writable workspace, runs `pixi install` (`--locked` when a `pixi.lock` is present), then `pixi run <pixiTask>`. The task must start a server on `0.0.0.0:8080` (`PORT=8080` and `HOME=/app` are injected). Max 64 chars. |

## spec.access

| Field | Type | Required | Description |
|---|---|---|---|
| `public` | bool | No | `true` disables authentication entirely (anonymous access). |
| `groups` | []string | No | Keycloak groups intended to use the app. Passed to the `NebariApp` as `auth.groups`, but **not enforced by the gateway in nebari-operator 0.1.0** — any signed-in realm user can open a private app. |
| `users` | []string | No | **Reserved.** Not used by the operator or the gateway. The API rejects a non-empty list with `422`; a value set with `kubectl` is stored and ignored. Tracked in [#67](https://github.com/nebari-dev/apps-pack/issues/67). |
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
| `WorkloadReady` | All desired replicas are ready. |
| `RoutingReady` | Mirrors the child `NebariApp`'s `Ready` condition (routing, TLS, auth). |

## Children

For each `App` the operator creates (and owns, via `ownerReferences`):

| Child | Name | Purpose |
|---|---|---|
| ConfigMap | `app-<name>-content` | Inline source files (inline apps only). |
| Deployment | `app-<name>` | The app workload (hardened: non-root, no privilege escalation, seccomp `RuntimeDefault`). |
| Service | `app-<name>` | ClusterIP on port 8080. |
| NebariApp | `app-<name>` | Routing + TLS + auth + (opt-in) landing-page tile, reconciled by the nebari-operator (contract pinned to `v0.1.0-alpha.20`). |

Deleting the `App` cascades through all of them.
