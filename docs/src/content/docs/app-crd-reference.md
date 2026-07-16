---
title: App CRD Reference
---

Complete field-by-field reference for the `App` custom resource.

**API Version:** `apps.nebari.dev/v1alpha1`
**Kind:** `App`
**Scope:** Namespaced — the namespace must be labeled `nebari.dev/managed=true`.
**Source:** [operator/api/v1alpha1/app_types.go](https://github.com/nebari-dev/nebari-apps-pack/blob/main/operator/api/v1alpha1/app_types.go)

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
    users: ["alice"]
    subdomain: team-site
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
| `owner` | string | No | Keycloak `preferred_username` that manages the app. The API sets this from the caller's token. |
| `source` | [AppSource](#specsource) | Yes | Where the app's content comes from. |
| `runtime` | [AppRuntime](#specruntime) | No | Process configuration: env, resources, replicas. |
| `access` | [AppAccess](#specaccess) | Yes | Who can reach the app and at which subdomain. |

## spec.source

| Field | Type | Required | Description |
|---|---|---|---|
| `type` | string | Yes | `git` \| `inline` \| `pvc`. Exactly one matching payload field must be set. |
| `inline` | [InlineSource](#inlinesource) | For `inline` | Small static content carried in the CR. |
| `git` | [GitSource](#gitsource) | For `git` | Static content cloned from a git repository. |
| `pvc` | [PVCSource](#pvcsource) | For `pvc` | Content already present on a PersistentVolumeClaim. |

### InlineSource

| Field | Type | Required | Description |
|---|---|---|---|
| `files` | map[string]string | Yes | Relative file paths → contents. Materialized as a ConfigMap-backed volume served by nginx. Keep under ~900KB total (ConfigMap limit). |

### GitSource

| Field | Type | Required | Default | Description |
|---|---|---|---|---|
| `url` | string | Yes | — | HTTPS git repository URL. |
| `ref` | string | No | `main` | Branch, tag, or commit. |
| `subdir` | string | No | repo root | Path within the repository containing the content root. Must not contain `..`. |

The clone happens in a non-root init container at pod start; re-deploying picks up the
current state of the ref.

### PVCSource

| Field | Type | Required | Description |
|---|---|---|---|
| `claimName` | string | Yes | Name of an existing PersistentVolumeClaim in the app's namespace. |
| `subPath` | string | No | Sub-path within the volume to serve. |

## spec.runtime

| Field | Type | Required | Default | Description |
|---|---|---|---|---|
| `env` | [][EnvVar](https://kubernetes.io/docs/reference/kubernetes-api/workload-resources/pod-v1/#environment-variables) | No | — | Environment variables. |
| `resources` | [ResourceRequirements](https://kubernetes.io/docs/concepts/configuration/manage-resources-containers/) | No | — | CPU/memory requests and limits. |
| `replicas` | int | No | `1` | Desired replicas. `0` stops the app (phase `Stopped`). |
| `keepAlive` | bool | No | `false` | Reserved for scale-to-zero idle reaping (not yet implemented). |

## spec.access

| Field | Type | Required | Description |
|---|---|---|---|
| `public` | bool | No | `true` disables authentication entirely (anonymous access). |
| `groups` | []string | No | Keycloak groups allowed to use the app. Empty = any signed-in user. |
| `users` | []string | No | Additional individual users. |
| `subdomain` | string | Yes | Lowercase DNS label. The app is served at `https://<subdomain>.<appsDomain>`. |

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
| NebariApp | `app-<name>` | Routing + TLS + auth + landing-page tile, reconciled by the nebari-operator (contract pinned to `v0.1.0-alpha.19`). |

Deleting the `App` cascades through all of them.
