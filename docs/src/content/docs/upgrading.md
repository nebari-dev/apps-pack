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

The UI's **Settings** page (account menu → **Settings**) shows the same version, next to the
UI's own.

## Roll back

```bash
helm history nebari-apps -n nebari-apps
helm rollback nebari-apps <REVISION> -n nebari-apps
```

`helm rollback` restores the workloads, RBAC and values, but not the CRD. CRD changes
within `v1alpha1` are additive ([versioning policy](/app-crd-reference/#versioning-and-deprecation),
checked in CI), so the newer CRD keeps working with the older operator.
If Apps were lost, re-apply the backup:

```bash
kubectl apply -f apps-backup-<date>.yaml
```

Status fields in the backup are ignored; the operator recomputes them.

## Version notes

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
  validation; `authz.image` ships with the chart.
- **App pods get default requests and limits** (`apps.defaultResources`) and at most 10
  replicas.
- **Auth is stricter.** Tokens must come from the pack's own Keycloak clients, and
  `api.auth.enabled=false` is refused on TLS installs.
- **MCP:** `remove_app` needs `confirm=true`; `get_app_logs` and `list_apps` return a
  different shape.
- **Releases** are cut from a release PR and published to the org Helm repository and
  GHCR; see [CI/CD & releasing](/ci-cd/).
