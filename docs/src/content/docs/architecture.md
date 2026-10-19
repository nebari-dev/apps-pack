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
   non-root init container.
4. **Service** — ClusterIP on port 8080.
5. **Routing** — a `NebariApp` (contract pinned to nebari-operator `%NEBARI_OPERATOR_VERSION%`,
   guarded by a contract test) carrying the hostname, auth policy, TLS setting, and
   landing-page entry.
6. **Status** — children's state folds back into phase, conditions, replica counts, and
   the URL.

All children carry `ownerReferences`, so deletion cascades and the reconcile loop converges
drift (edit or delete a child and it is restored).

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
app (`spec.owner`, stamped from `preferred_username` on create) or belong to one of
`api.adminGroups`. Lists and analytics are filtered the same way.

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

`access.groups` is forwarded to the `NebariApp`, but nebari-operator `0.1.0` does not yet
turn it into a gateway authorization rule, so a private app is open to **every signed-in
realm user**; `access.users` is not used at all. See the
[Known limitations](https://github.com/nebari-dev/apps-pack#known-limitations).

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
- The API acts with a dedicated ServiceAccount. Inside each namespace in
  `api.allowedNamespaces` it gets a `RoleBinding` for `App` CRUD, read-only observability
  (pods, logs, events), and one narrow write: patching child Deployments to roll pods for
  restart. Cluster-wide it can only list namespaces and read `metrics.k8s.io` pod usage.
  Only when `api.allowedNamespaces` is empty (namespaces discovered by label) is the
  namespaced grant bound cluster-wide. On top of that, the API's owner-or-admin check is
  the boundary between users. The operator's RBAC covers only the resources it reconciles,
  plus read-only access to PersistentVolumeClaims.
- A `pvc` source mounts a claim only if the claim is labeled `apps.nebari.dev/mountable=true`,
  so a shared or team volume cannot be published by anyone who can create an App.
- Treat every app as untrusted user code: tenancy is per-namespace, and only opted-in
  namespaces (`nebari.dev/managed=true`) can host apps.
