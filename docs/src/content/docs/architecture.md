---
title: Architecture & auth
---

## One contract, many producers

Every producer — the UI, the REST API, the MCP server, and `kubectl`/GitOps — writes the
same **`App`** custom resource. Nothing else in the system knows how to assemble workloads:

```
UI ────────┐
REST API ──┤                          ┌─ Deployment (app pod)
agent/MCP ─┼─►  App CR  ─► apps-      ─┼─ Service
GitOps ────┘  (one         operator    └─ NebariApp ─► nebari-operator ─► HTTPRoute + TLS
              contract)                                                   + Keycloak + tile
```

The **apps-operator** owns workload creation; the
[nebari-operator](https://github.com/nebari-dev/nebari-operator) owns everything at the
edge. This pack fills exactly the gap the platform leaves open: `NebariApp` routes to a
Service that must already exist — the apps-operator is what creates it.

## The reconcile pipeline

For each `App`, the operator runs an ordered, idempotent pipeline:

1. **Validate** — namespace opted in (`nebari.dev/managed=true`), source type supported,
   required fields present. Failures set `Validated: False` and
   phase `Failed`; they are terminal until the spec changes.
2. **Content** — inline sources materialize as a ConfigMap; a checksum on the pod template
   rolls the pods whenever the files change.
3. **Workload** — a hardened Deployment (non-root, dropped capabilities, seccomp
   `RuntimeDefault`): nginx serving the app's content, with git sources cloned by a
   non-root init container. Static apps run an operator-written nginx config (a
   `<app>-server` ConfigMap mounted over `/etc/nginx/conf.d`) that adds security headers.
   An App restricted to groups or users also gets the `authz` sidecar (next section), and so
   does an App that can idle, where the sidecar records activity. Before the Deployment is
   applied the operator runs the **idle check** (below) and scales an idle App to zero.
4. **Service** — ClusterIP on port 8080.
5. **Routing** — a `NebariApp` (contract pinned to nebari-operator `%NEBARI_OPERATOR_VERSION%`,
   guarded by a contract test) carrying the hostname, auth policy, TLS setting, and
   landing-page entry.
6. **Status** — children's state folds back into phase, conditions, replica counts, and
   the URL.

All children carry `ownerReferences`, so deletion cascades and the reconcile loop converges
drift (edit or delete a child and it is restored).

## Scale to zero

An App that goes its idle timeout without a request is scaled to zero and wakes on the next
request ([details](/app-crd-reference/#scale-to-zero)). The pieces:

- **Activity.** The `authz` sidecar counts requests that reach the app and serves the time of
  the last one on its health port (`GET :8082/activity`). Apps that restrict nobody run it in
  passthrough mode, so public and restricted Apps are measured the same way. The operator polls
  every ready pod (requeueing the App on a timer) and keeps the result in
  `status.lastActivityTime`. A pod it cannot read counts as active.
- **Idle.** Past the timeout the Deployment goes to zero replicas and the phase to `Idle`.
  `spec.runtime.replicas` is untouched, so `Stopped` stays the owner's decision.
- **Wake.** An idle App's `NebariApp` routes to the activator, an HTTP server inside every
  operator replica behind the `<release>-activator` Service (a cross-namespace backend allowed by
  a `ReferenceGrant` the operator maintains). It answers with a self-reloading "starting" page
  and stamps the `apps.nebari.dev/wake-requested-at` annotation on the App. The annotation is
  activity, so the reconcile it triggers scales the Deployment back up; routing returns to the
  App's Service when a pod is ready. Visitors see the starting page, never a gateway error.

```text
request ─▶ gateway ─▶ NebariApp ─┬─ running: app-<name> Service ─▶ authz sidecar ─▶ app
                                 └─ idle:    <release>-activator ─▶ operator: page + wake annotation
```

## Authentication

Two deliberately different models:

### The UI and API — app-native OIDC

The UI's `NebariApp` sets `enforceAtGateway: false` and provisions the pack's Keycloak
clients: a confidential one, a **public SPA client** (`auth.spaClient`), and — when the MCP
server is enabled — the **device-flow client** (`auth.deviceFlowClient`) used by agent
logins. The UI boots
[keycloak-js](https://www.keycloak.org/securing-apps/javascript-adapter) with runtime config
served by the API (`GET /api/v1/config`), runs the PKCE login flow, and attaches the access
token to every request. The API validates tokens against the realm **JWKS** (with an
optional in-cluster JWKS URL for split-horizon clusters) and derives the caller's identity
and groups from the claims. Tokens must have been issued to one of this pack's own clients
(the SPA or the device-flow client, checked against `azp`/`aud`), so a token another realm
client obtained is refused. It then authorizes every request: the caller must own the
app (`spec.owner`, stamped from `preferred_username` on create), be one of its managers
(`spec.access.managers`: a listed username, or a group in the token's `groups` claim), or
belong to one of `api.adminGroups`. Only the owner and admins may change the manager list.
Lists and analytics are filtered the same way.

### The MCP endpoint — verified twice

The MCP endpoint at `/mcp` is connectable without a token (the device-flow login has to
start somewhere), but middleware verifies every tool call's JWT against the realm JWKS
before it runs — anonymous or forged callers get told to `authenticate`. apps-api then
validates the same token again, so the MCP proxies only as the authenticated user.

### Launched apps — gateway-enforced only

Apps never contain auth code. A private app's `NebariApp` creates an Envoy Gateway
`SecurityPolicy`: unauthenticated browsers are redirected to Keycloak and must sign in.
`access.public: true` skips the policy entirely. This keeps user workloads honest — there is
no token to mishandle inside an app pod.

The gateway only signs users in; it has no group or user rule
([nebari-operator#153](https://github.com/nebari-dev/nebari-operator/issues/153)). So when a
private App lists `access.groups` or `access.users`, the operator enforces them in the pod:
the `NebariApp` sets `forwardAccessToken: true`, and the Deployment gets the **apps-authz**
sidecar on port 8080 in front of the app container (moved to 8081). The sidecar verifies
the forwarded Keycloak access token against the realm's keys and lets in a member of any
listed group or a listed user; everyone else gets `403`. `access.groups` also goes to the
`NebariApp` as `auth.groups` (landing-page tile visibility); `access.users` does not, since
`NebariApp` has no per-user field. See [Access control](/launching-apps/#access-control).

## TLS

`tls.enabled` (chart value) flows to every `NebariApp` this pack emits
(`routing.tls.enabled`) and into app status URLs. Enabled (default), each hostname gets a
cert-manager certificate and HTTPS listener; disabled, everything serves plain HTTP — used
by the local dev stack to avoid self-signed certificate friction.

## URL scheme

Apps live under a dedicated zone one level below the cluster domain:

```
https://<subdomain>.apps.<cluster-domain>    # each app
https://apps.<cluster-domain>                # the UI itself
```

The zone is configurable via the `appsDomain` value (default `apps.<clusterDomain>`).

## Security posture

- App pods run non-root with dropped capabilities, seccomp `RuntimeDefault`, and no
  privilege escalation; static content mounts read-only. They get no ServiceAccount token
  (`automountServiceAccountToken: false`), and every container, init containers included,
  gets cpu/memory requests and limits (the App's own, or the chart defaults). The chart can
  add a `LimitRange` and a `NetworkPolicy` that keeps app pods off cluster-internal
  addresses.
- Git init containers receive user input via environment variables — never interpolated
  into shell — and subdirectories are validated against path traversal.
- Uploads are size-capped, text-only, and rejected on unsafe archive paths.
- The UI sends a Content-Security-Policy on every response: scripts only from its own
  origin plus the pre-paint theme script by hash, network requests only to itself and the
  Keycloak origin, no plugins, no framing (`frame-ancestors 'none'`, `X-Frame-Options: DENY`).
  It also sends `nosniff`, `Referrer-Policy`, `Permissions-Policy`, COOP and, when
  `tls.enabled`, HSTS. CI boots the image and checks the set (`ui/scripts/check-headers.sh`).
- Static apps are served with `nosniff`, `Referrer-Policy`, and framing limited to their own
  origin. Their scripts are not restricted: a CSP sandbox would break same-origin requests
  and storage for ordinary sites, so isolation between apps rests on each app having its own
  hostname.
- The API acts with a dedicated ServiceAccount. Inside each namespace in
  `api.allowedNamespaces` it gets a `RoleBinding` for `App` CRUD, read-only observability
  (pods, logs, events), and one narrow write: patching child Deployments to roll pods for
  restart. Cluster-wide it can only list namespaces and read `metrics.k8s.io` pod usage.
  Only when `api.allowedNamespaces` is empty (namespaces discovered by label) is the
  namespaced grant bound cluster-wide. On top of that, the API's owner, manager or admin check
  is the boundary between users. The operator's RBAC covers only the resources it reconciles,
  plus read-only access to PersistentVolumeClaims and pods (the idle check), and the
  activator's `ReferenceGrant` in its own namespace.
- The operator reads each idling App's activity from the pod, which runs untrusted code: the
  answer is size- and time-bounded, a time in the future is clamped to now, and any failure
  counts as activity, so a pod can at worst keep its own App awake (what `keepAlive` allows
  anyway). The activator reveals only the host the caller asked for, and waking costs the
  App's resources, nothing more: any request that reaches an idle App's URL wakes it,
  including a signed-in user outside a restricted App's groups (the sidecar still refuses them
  once the App is up).
- A `pvc` source mounts a claim only if the claim is labeled `apps.nebari.dev/mountable=true`,
  so a shared or team volume cannot be published by anyone who can create an App.
- Treat every app as untrusted user code: tenancy is per-namespace, and only opted-in
  namespaces (`nebari.dev/managed=true`) can host apps.
