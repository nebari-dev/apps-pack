---
title: Runbook
description: Respond to Apps Pack incidents - the operator stops reconciling, routing never comes up, Keycloak is unreachable, metrics are missing - and roll back.
---

This page is for operating the pack itself. For one App that will not launch, start with
[Troubleshooting](/troubleshooting/). Commands assume the release `nebari-apps` in the
namespace `nebari-apps`; substitute yours.

A quick health check of the whole pack:

```bash
kubectl -n nebari-apps get deploy,pods -l app.kubernetes.io/instance=nebari-apps
kubectl get apps -A -o custom-columns=NS:.metadata.namespace,NAME:.metadata.name,PHASE:.status.phase,LAST:.status.lastActivityTime,MESSAGE:.status.message
curl -s https://apps.<cluster-domain>/api/v1/version
```

## Alerts

With `telemetry.prometheusRule.enabled` the chart renders these alerts (see
[Metrics](/configuration/#metrics)). Each one links to the section below that handles it.

| Alert | Severity | Fires when | Section |
|---|---|---|---|
| `NebariAppsOperatorDown` | critical | No healthy scrape of the operator for 10m | [The operator is not reconciling](#the-operator-is-not-reconciling) |
| `NebariAppsReconcileErrors` | warning | App reconciles keep failing for 15m | [The operator is not reconciling](#the-operator-is-not-reconciling) |
| `NebariAppsReconcileBacklog` | warning | More than 25 Apps queued for 15m | [The operator is not reconciling](#the-operator-is-not-reconciling) |
| `NebariAppsAPIDown` | critical | No healthy scrape of apps-api for 5m | [The API is down or returns errors](#the-api-is-down-or-returns-errors) |
| `NebariAppsAPIErrorRate` | warning | Over 5% of API requests are 5xx for 10m (`apiErrorRatio`) | [The API is down or returns errors](#the-api-is-down-or-returns-errors) |
| `NebariAppsPodsUnavailable` | warning | A pack Deployment has unavailable replicas for 10m (kube-state-metrics) | [A pack pod is not ready](#a-pack-pod-is-not-ready) |
| `NebariAppsPodRestarting` | warning | A pack pod restarted more than 3 times in 30m (kube-state-metrics) | [A pack pod is not ready](#a-pack-pod-is-not-ready) |

## The operator is not reconciling

Symptoms: new Apps stay without a phase, edits do not roll pods, `Stopped` Apps keep
running, `Idle` Apps never wake (their URL keeps showing the starting page).

```bash
kubectl -n nebari-apps get deploy nebari-apps-operator
kubectl -n nebari-apps logs deploy/nebari-apps-operator --since=30m | grep -E '"level":"(error|warn)"'
kubectl -n nebari-apps get lease apps-operator.apps.nebari.dev -o jsonpath='{.spec.holderIdentity}{"\n"}'
```

- **The pod is not running.** See [A pack pod is not ready](#a-pack-pod-is-not-ready).
- **Running, but the logs repeat `forbidden`.** The operator's RBAC does not match its image:
  the chart and the images are from different releases. Upgrade them together (see
  [Upgrading](/upgrading/)).
- **Running, but no replica holds the lease.** With `operator.replicaCount` above 1, only the
  leader reconciles. A holder that no longer exists is replaced within about a minute; if not,
  restart the Deployment.
- **`reconcile failed` for some Apps.** The message names the child that failed. A webhook
  or quota refusing the Deployment shows up here first. The App's `status.message` and
  `kubectl -n <ns> get events --field-selector involvedObject.name=app-<name>` usually say
  more.
- **A backlog after a restart or a mass change.** The work queue drains on its own; it stays
  high only if each reconcile is slow (look at `controller_runtime_reconcile_time_seconds`)
  or failing.

Restarting the operator is safe: it holds no state, and every App is reconciled again from
its spec.

```bash
kubectl -n nebari-apps rollout restart deploy/nebari-apps-operator
```

## A NebariApp never becomes Ready

`RoutingReady=False` on an App (or on the UI itself) is the nebari-operator's domain:
routing, TLS and the Keycloak client are created from the `NebariApp` this pack writes.

```bash
kubectl -n <ns> get nebariapp app-<name> -o jsonpath='{range .status.conditions[*]}{.type}={.status} {.reason}: {.message}{"\n"}{end}'
kubectl -n nebari-operator-system logs deploy/nebari-operator-controller-manager --since=30m
```

- **`NebariAppMissing` that does not clear.** The NebariApp CRD is not installed, or is older
  than the pinned contract (nebari-operator `%NEBARI_OPERATOR_VERSION%`).
- **TLS not ready.** cert-manager could not issue the certificate:
  `kubectl -n <ns> get certificate,certificaterequest,challenge`. A rate-limited or failed
  ACME order clears when the challenge succeeds; local clusters without public DNS should
  run with `tls.enabled=false`.
- **Auth not ready.** The nebari-operator could not create the Keycloak client. Check that
  Keycloak is up and that the nebari-operator's admin credentials are valid.
- **`GroupsNotResolved`, `GroupsEmpty` or `GroupsClaimConflict`.** The App's
  `access.groups` cannot be enforced as written (a path missing in Keycloak, entries that
  name no group, or a groups mapper in the wrong form), so the gateway denies its users until
  it is fixed. The App's `RoutingReady` message carries the reason; see
  [Troubleshooting](/troubleshooting/).
- **Every App at once.** The shared Gateway (`gateway`) or the nebari-operator itself is
  down; fix that, and the NebariApps recover without touching the Apps.

## Group access

`access.groups` are enforced at the gateway, by the group rule nebari-operator adds to each
restricted App's SecurityPolicy (`%NEBARI_OPERATOR_VERSION%` or later). The apps-proxy sidecar
in app pods checks nothing.

```bash
kubectl -n <ns> get nebariapp app-<name> -o jsonpath='{.spec.auth.groups}{"\n"}'
kubectl -n <ns> get securitypolicy app-<name>-security -o jsonpath='{.spec.authorization}{"\n"}'
```

- **A member gets `403`.** Compare the token's groups (full paths) with the policy's values:
  `/finance` does not admit someone only in `/finance/analysts`. A user just added to a group
  signs out and back in; one removed keeps access until their token expires (5 minutes by
  default).
- **Everyone signed in gets in.** No `authorization` in the policy: nebari-operator is older
  than `%NEBARI_OPERATOR_VERSION%`, or the App lists no groups.
- **Users of restricted Apps were all signed out at once.** Expected once after upgrading
  nebari-operator: the access-token cookie of a group-enforcing App is renamed
  (`nebari-at-<namespace>-<name>`). See [Upgrading](/upgrading/).
- **Keep the gateway the only way in.** With the chart's `apps.networkPolicy.enabled` off,
  other pods in the cluster can reach an app's Service without passing the group rule.

## Idle Apps do not idle or do not wake

`Idle` is a normal phase: the App went its idle timeout (`runtime.idleTimeoutMinutes`, else
`apps.idle.timeoutMinutes`) without a request and is scaled to zero. The next request to its
URL starts it. See [Scale to zero](/app-crd-reference/#scale-to-zero).

```bash
kubectl get apps -A -o wide        # PHASE and LAST ACTIVE
kubectl -n <ns> get app <name> -o jsonpath='{.metadata.annotations.apps\.nebari\.dev/wake-requested-at}{"\n"}'
kubectl -n nebari-apps get svc,endpoints nebari-apps-activator
kubectl -n nebari-apps get referencegrant nebari-apps-activator -o yaml
kubectl -n nebari-apps logs deploy/nebari-apps-operator --since=30m | grep -E 'idle check failed|activator'
```

- **An App never idles.** Check that it can idle at all: `keepAlive` unset, `replicas` above 0,
  a timeout above 0, and the pod has the `proxy` container. Then look for `idle check failed`
  in the operator log: the operator could not read the sidecar's activity (port 8082 on the pod
  IP) and kept the App running; `LAST ACTIVE` stays at the last request it did see. A
  NetworkPolicy that blocks the operator's namespace from port 8082 is the usual cause; the
  chart's own policy allows it. Something polling the app (an uptime check, a browser tab that
  refreshes) is activity too.
- **An App idles late on a local cluster.** A laptop that sleeps pauses a kind cluster, and the
  idle check with it; it runs again on wake. Compare the gap with the host's sleep log
  (`pmset -g log | grep -E 'Sleep|Wake'` on macOS).
- **The URL returns `503` "no healthy upstream" or `500` while the App is `Idle`.** Routing to
  the activator is broken. The `nebari-apps-activator` Service needs endpoints (the operator
  pods, port 8090), and the `ReferenceGrant` of the same name needs an entry for the App's
  namespace: without it the gateway refuses the cross-namespace backend (the `HTTPRoute`'s
  `ResolvedRefs` condition is `False`). The operator recreates both entries on the next
  reconcile; restart it if they are missing.
- **The starting page shows but the App stays `Idle`.** The activator could not stamp the wake
  annotation (look for `waking app failed` in the operator log; usually RBAC from a mismatched
  chart and image). Starting the App from the UI or `POST /api/v1/apps/<ns>/<name>/start` sets
  the same annotation.
- **The App wakes but the page never leaves the starting screen.** The App is `Deploying` with
  no ready pod: troubleshoot it like any App that does not start ([Troubleshooting](/troubleshooting/)).
  A Python app reinstalls its environment on every cold start, which can take minutes.
- **Turn idling off quickly.** Set `apps.idle.timeoutMinutes=0` and upgrade: Apps without their
  own `idleTimeoutMinutes` wake and keep running (their pods roll once to drop the sidecar,
  except image Apps, which always run it).
  For one App, set `runtime.keepAlive: true`.

## The API is down or returns errors

apps-api backs the UI and the MCP server; launched apps keep serving while it is down.

```bash
kubectl -n nebari-apps get pods -l app.kubernetes.io/component=api
kubectl -n nebari-apps exec deploy/nebari-apps-api -- python -c \
  "import urllib.request as u; print(u.urlopen('http://127.0.0.1:8080/api/v1/readyz').read().decode())" \
  || true
kubectl -n nebari-apps logs deploy/nebari-apps-api --since=15m | grep -E '"status": 5|"level": "(error|warning)"'
```

`readyz` names the failing check; the log line `readiness check failed` gives the reason.

- **`kubernetes` failed.** The API server is unreachable from the pod, or the API's
  ServiceAccount lost its RBAC (chart and images from different releases).
- **`jwks` failed.** See [Keycloak or JWKS is unreachable](#keycloak-or-jwks-is-unreachable).
- **5xx on `/api/v1/apps…` while ready.** Usually the Kubernetes API server timing out or
  refusing a write (admission webhooks, quotas). Every response carries an `X-Request-ID`
  header, and the API's log line for that request has the same `request_id`, so a failing
  call in the browser's network tab leads straight to its log line.

## Keycloak or JWKS is unreachable

With auth on, apps-api and the MCP server verify every token against the realm's JWKS. If
the pods cannot fetch it, `readyz` fails on `jwks`, the pods drop out of the Service, and
users see `503`s or a login loop.

```bash
kubectl -n nebari-apps exec deploy/nebari-apps-api -- python -c \
  "import os, urllib.request as u; print(u.urlopen(os.environ.get('OIDC_ISSUER_INTERNAL') or os.environ['OIDC_ISSUER']).status)"
```

- **The browser URL does not resolve inside the cluster** (split-horizon DNS, a hairpin the
  load balancer does not allow). Set `keycloak.internalUrl` to the in-cluster Keycloak
  Service; tokens keep their public issuer.
- **Keycloak is down.** Nothing in the pack can fix that; users cannot sign in to anything.
  `readyz` trusts a successful JWKS fetch for a minute, so a brief blip does not take the API
  out of the Service; a longer outage does.
- **Every token is rejected with `401` but JWKS loads.** The pack's Keycloak clients are
  missing from `<release>-ui-oidc-client`, so the allowed-client list is empty and the API
  fails closed. Check the UI's NebariApp (`RoutingReady`) and that the secret exists.

## metrics-server is missing

The live CPU and memory usage on an app's detail page (its Resources card) read
`metrics.k8s.io`. Without metrics-server that card says "Live usage needs metrics-server"
and still shows the limits; restarts, the last termination reason and uptime (the Restarts
card, and the Apps page's Needs attention banner) come from pod status and still work.
Nothing else depends on it.

```bash
kubectl get apiservice v1beta1.metrics.k8s.io
kubectl top pods -n apps
```

Install metrics-server (most distributions ship it; on kind, add `--kubelet-insecure-tls`).
If the APIService exists but reports `Available=False`, metrics-server is running but the API
server cannot reach it; check its pod and any NetworkPolicy in `kube-system`.

## A pack pod is not ready

```bash
kubectl -n nebari-apps get pods -l app.kubernetes.io/instance=nebari-apps
kubectl -n nebari-apps describe pod <pod>        # probe failures, OOMKilled, image pulls
kubectl -n nebari-apps logs <pod> --previous     # why the last container exited
```

| Pod | Probes | Common causes |
|---|---|---|
| operator | `/healthz`, `/readyz` on 8081 | RBAC mismatch, no leader lease, OOMKilled at `operator.resources` |
| api | `/api/v1/healthz`, `/api/v1/readyz` | JWKS or the Kubernetes API unreachable (see above) |
| ui | `/healthz` | nginx cannot resolve the API or MCP Service at startup; check the Services exist |
| mcp | `/healthz` | API_URL wrong or the API down |

Every pack pod runs with a read-only root filesystem. A crash with `Read-only file system`
means something wrote outside its `emptyDir` (`/tmp`, or `/tmp/nginx` for the UI): an image
built for a different chart version. Upgrade chart and images together.

## Roll back a bad upgrade

Back up the Apps, roll the release back, and confirm (details in
[Upgrading → Roll back](/upgrading/#roll-back)):

```bash
kubectl get apps -A -o yaml > apps-backup-$(date +%F).yaml
helm history nebari-apps -n nebari-apps
helm rollback nebari-apps <REVISION> -n nebari-apps --wait
kubectl -n nebari-apps rollout status deploy/nebari-apps-operator deploy/nebari-apps-api
kubectl get apps -A
```

With Argo CD, set `targetRevision` back to the previous version and sync; disable
auto-sync first if a newer revision would be re-applied.

`helm rollback` does not touch the CRD. Under the [CRD versioning
policy](/app-crd-reference/#versioning-and-deprecation), CRD changes within a version are
additive, so the newer CRD keeps working with the older operator. If Apps were deleted, apply
the backup; the operator recreates every child and recomputes status.
