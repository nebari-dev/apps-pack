# Nebari Apps Pack — Design Document

**Status:** Draft for review
**Author:** (you) + Claude
**Date:** 2026-06-15
**Related:** `nebari-operator`, `nebari-llm-serving-pack`, `jhub-apps`

---

## 1. Summary

The **Nebari Apps Pack** is a Nebari Software Pack that lets users launch, manage, and
observe **static web apps** (HTML/CSS/JS bundles served by nginx) on a Nebari Kubernetes
cluster. Apps run as **pods** behind Nebari's gateway with Keycloak SSO.

> **Scope note:** Python app support was removed 2026-07-16 in favor of
> [python-capability-pack](https://github.com/nebari-dev/python-capability-pack), which owns
> Python services. This document describes the static-only pack.

Apps can be created and launched through four interfaces that all converge on a single
declarative resource (the `App` custom resource):

1. **A coding agent** (Claude Code, Codex) — generates an app, then the user launches it with
   **natural language** via an in-cluster **MCP server**.
2. **The MCP server** directly (tool calls: launch / list / access / remove / logs).
3. **A REST API** (programmatic CRUD + observability).
4. **A form-based UI** — like `jhub-apps`, but with **no JupyterHub dependency**.

A companion **Claude Code skill** teaches agents how to scaffold static apps in the exact
layout this pack expects, so "generate then launch" is a smooth flow.

---

## 2. Goals & Non-Goals

### Goals
- Launch **static web** apps as pods on Nebari, behind Keycloak SSO.
- One **declarative `App` resource** that the UI, API, MCP, *and* optional GitOps all produce.
- **Natural-language launching** of agent-generated apps via an in-cluster **MCP** server.
- A **form-based launch UI** modeled on `jhub-apps` but free of JupyterHub.
- **CRUD + observability** API and UI (status, logs, events, resource usage, URLs).
- **MCP authenticates to Keycloak** (device flow for CLI/agents).
- A **skill** to scaffold compatible static apps.
- Reuse Nebari conventions: Helm chart, `pack-metadata.yaml`, `NebariApp` for routing/auth.

### Non-Goals (v1)
- Not a general PaaS / arbitrary container scheduler (static content only).
- **No Python apps** — Python services are out of scope; see
  [python-capability-pack](https://github.com/nebari-dev/python-capability-pack).
- Not building a new auth system — Keycloak (via nebari-operator) is the IdP.
- No multi-cluster federation in v1.
- No autoscaling beyond fixed replicas + optional scale-to-zero (deferred; see §15).

---

## 3. Background & Reused Building Blocks

The Nebari ecosystem already provides most of the primitives. The Apps Pack composes them
rather than reinventing.

| Component | What it gives us | How the Apps Pack uses it |
|---|---|---|
| **nebari-operator** (`reconcilers.nebari.dev/v1`, `NebariApp` CRD, Go/kubebuilder) | Given an *existing* Service, it provisions an `HTTPRoute`, a cert-manager `Certificate`, an Envoy `SecurityPolicy`, an **auto-provisioned Keycloak OIDC client**, and a **landing-page tile**. It does **not** create workloads. | The Apps operator creates the Deployment+Service, then emits a `NebariApp` per app to get routing + TLS + SSO + landing-page registration "for free." |
| **nebari-llm-serving-pack** (CRD + Go operator + UI, Helm) | The reference template for "a pack with a CRD, an operator, and a UI" wired through `NebariApp`. | Direct structural template for the Apps operator + Helm chart + `pack-metadata.yaml`. |
| **jhub-apps** (FastAPI + React; app data model; form UX; sharing) | Battle-tested **app data model** and a proven form UX. | We port the *model*, drop the JupyterHub spawner/proxy/registry (replaced by k8s + nebari-operator), and reuse the form-UI patterns. |

### Key gap this pack fills
`NebariApp` routes to a Service that **must already exist**. Nothing in the ecosystem
*creates the workload* for an arbitrary user app. **The Apps Pack owns workload creation** —
that is its reason to exist.

---

## 4. Architecture Overview

```
                         ┌─────────────────────────────────────────────────────────┐
   Coding agent          │                    Nebari cluster                        │
   (Claude Code /         │                                                          │
    Codex) generates app  │   ┌────────────┐   reads/writes   ┌──────────────────┐  │
        │                 │   │  apps-mcp  │ ───────────────► │    apps-api      │  │
        │ "launch it"     │   │ (FastMCP)  │                  │   (FastAPI)      │  │
        ▼                 │   └────────────┘                  └───────┬──────────┘  │
   ┌──────────┐  HTTP/MCP │         ▲                                 │ creates/    │
   │  user /  │ ──────────┼─────────┘                                 │ patches     │
   │  agent   │           │   ┌────────────┐   REST/CRUD              ▼ App CR      │
   └──────────┘  ─────────┼─► │  apps-ui   │ ──────────────►  ┌──────────────────┐  │
        │  browser        │   │  (React)   │                  │  App CR (etcd)   │  │
        │                 │   └────────────┘                  │ apps.nebari.dev  │  │
        │                 │                                   └───────┬──────────┘  │
        │  (optional)     │   ┌────────────┐  git sync                │ watch       │
        │  GitOps ────────┼─► │  ArgoCD    │ ─────────────────────────┤             │
        │                 │   └────────────┘                          ▼             │
        │                 │                              ┌──────────────────────┐   │
        │                 │                              │   apps-operator      │   │
        │                 │                              │   (Go / kubebuilder) │   │
        │                 │                              └───────────┬──────────┘   │
        │                 │   reconciles into:                       │              │
        │                 │   ┌──────────────┐  ┌──────────┐  ┌──────▼────────┐     │
        │                 │   │  Deployment  │  │ Service  │  │   NebariApp   │     │
        │                 │   │  (nginx pod) │  │          │  │ (routing+auth)│     │
        │                 │   └──────────────┘  └────┬─────┘  └──────┬────────┘     │
        │                 │                          │               │ reconciled   │
        │                 │                          │               │ by           │
        │                 │                          │               ▼ nebari-op     │
        │                 │                          │   HTTPRoute + Cert + OIDC     │
        │                 │                          │   + landing-page tile        │
        │                 │                          │                              │
        └─────────────────┼──────── app URL ─────────┴──── Envoy Gateway ───────────┘
          https://<app>.<cluster>           (Keycloak SSO via SecurityPolicy)
```

**The pattern in one sentence:** every producer (agent/MCP, API, UI, GitOps) ends up writing
an `App` CR; the **apps-operator** turns that into a Deployment + Service + `NebariApp`; the
**nebari-operator** turns the `NebariApp` into routing + TLS + SSO + a landing-page tile.

### Components built by this pack
| Component | Language / stack | Responsibility |
|---|---|---|
| **App CRD** | YAML (`apps.nebari.dev/v1alpha1`) | The declarative contract for an app. |
| **apps-operator** | Go + kubebuilder/controller-runtime | Reconcile `App` → Deployment, Service, `NebariApp`, status. |
| **apps-api** | Python FastAPI (async SQLAlchemy, pydantic v2) | CRUD + observability; writes `App` CRs; the authority all clients use. |
| **apps-ui** | React + TS + Vite + shadcn/ui + Tailwind v4 | Form-based launch + management + observability dashboards. |
| **apps-mcp** | Python FastMCP | Agent-facing tools; Keycloak device-flow auth; calls apps-api. |
| **apps skill** | Claude Code skill (markdown + templates) | Scaffold static apps in the expected layout. |

> **Why the API is the authority (not the CRD directly):** the API centralizes validation,
> RBAC, observability aggregation, and audit. MCP and UI never touch the
> Kubernetes API directly; they go through apps-api. GitOps is the one path that writes CRs
> without the API — that's an explicit, advanced opt-in.

---

## 5. The `App` Custom Resource

`App` is the heart of the design. Group `apps.nebari.dev`, version `v1alpha1`, **namespaced**
(an app lives in a project/team namespace labeled `nebari.dev/managed`).

```yaml
apiVersion: apps.nebari.dev/v1alpha1
kind: App
metadata:
  name: docs-site
  namespace: team-analytics
  labels:
    apps.nebari.dev/owner: jbouder            # Keycloak sub / preferred_username
spec:
  displayName: "Docs Site"
  description: "Team documentation"
  thumbnail: "data:image/png;base64,..."       # optional
  owner: jbouder

  source:                                       # where the app's content comes from
    type: git                                   # git | inline | pvc
    # --- type: git ---
    git: { url: "https://github.com/...", ref: "main", subdir: "site" }
    # --- type: inline (small static content carried in the CR) ---
    # inline: { files: { "index.html": "<!doctype html>..." } }
    # --- type: pvc (content already on a volume) ---
    # pvc: { claimName: "docs-content", subPath: "site" }

  runtime:
    env:
      - name: LOG_LEVEL
        value: info
    resources:
      requests: { cpu: "250m", memory: "512Mi" }
      limits:   { cpu: "2",    memory: "4Gi" }
    keepAlive: false                            # if false + scaleToZero enabled, idle apps scale down
    replicas: 1

  access:
    public: false                              # true => no auth (anonymous)
    groups: ["analytics"]                      # Keycloak/OIDC groups allowed
    users:  ["alice", "bob"]                   # additional individual users
    subdomain: docs-site                       # => https://docs-site.<cluster-domain>

status:
  phase: Running                               # Pending|Deploying|Running|Failed|Stopped
  url: "https://docs-site.cluster.example.com"
  replicas: { desired: 1, ready: 1 }
  conditions:
    - type: WorkloadReady   ; status: "True"
    - type: RoutingReady    ; status: "True"   # mirrors NebariApp readiness
    - type: Validated       ; status: "True"
  observedGeneration: 4
  lastTransitionTime: "2026-06-15T12:00:00Z"
  message: "All replicas ready"
```

### Source types
Every app is served by an unprivileged nginx on port 8080; auth is enforced at the gateway
by the `NebariApp` `SecurityPolicy` (never inside the app pod).

| `source.type` | Best for | How the content gets into the pod |
|---|---|---|
| `inline` | small sites (text assets, ≲900KB) | files carried in the CR, materialized as a ConfigMap-backed volume |
| `git` | version-controlled sites | a non-root init container clones the repo at pod start |
| `pvc` | larger sites / content already on a volume | mounts an existing PersistentVolumeClaim |

`kubectl get apps` printer columns show the **Source** (`.spec.source.type`) alongside phase
and URL.

---

## 6. Workload Model — How Apps Run as Pods

This section answers the central question: *how do pods fit the pack framework?*

### Reconcile pipeline (apps-operator)
For each `App`, the operator runs an ordered, idempotent pipeline (mirroring nebari-operator's
core→routing→tls→auth structure):

1. **Validate** — namespace is `nebari.dev/managed`; source is coherent; owner set. Sets the
   `Validated` condition.
2. **Workload** — create/update a **Deployment**: an nginx image serving content into the web
   root, sourced by `source.type`: `inline` (files carried in the CR, materialized as a
   ConfigMap-backed volume — best for small sites), `pvc` (mount an existing volume — best for
   larger sites), or `git` (init-container clone). **Local-file launches** (a directory with an
   `index.html`) are an *authoring convenience*: the API/MCP/UI bundles the uploaded files
   and renders them into the CR as `inline` (small) or a provisioned `pvc` (large) — see §11.
   Apply resources, env, replicas, probes (readiness on the listen port), security context
   (non-root, read-only FS), and standard labels.
3. **Service** — a `ClusterIP` Service on the listen port.
4. **Routing/Auth/Landing** — emit a **`NebariApp`** owned by this `App`:
   ```yaml
   apiVersion: reconcilers.nebari.dev/v1
   kind: NebariApp
   metadata: { name: app-docs-site, namespace: team-analytics, ownerReferences: [<App>] }
   spec:
     hostname: docs-site.cluster.example.com         # from access.subdomain + cluster domain
     gateway: public                                  # or internal
     service: { name: app-docs-site, port: 8080 }
     routing: { routes: [ { pathPrefix: "/" } ] }
     auth:
       enabled: true                                  # false if access.public
       provider: keycloak
       provisionClient: true                          # nebari-operator creates the OIDC client
       scopes: [openid, profile, email, groups]
       allowedGroups: ["analytics"]                   # maps from access.groups
     landingPage:
       enabled: true
       displayName: "Docs Site"
       category: "Apps"
       icon: "<thumbnail or default>"
   ```
   The nebari-operator then provisions HTTPRoute + Certificate + SecurityPolicy + Keycloak
   client + landing-page tile.
5. **Status** — aggregate workload + NebariApp conditions; publish `status.url`, phase,
   replica counts, and a human-readable message.

### Ownership & garbage collection
The `App` owns the Deployment, Service, and `NebariApp` via `ownerReferences`. Deleting the
`App` (via API → CR delete, or `kubectl delete`) cascades automatically; the nebari-operator
tears down routing/cert/OIDC client.

### Why a CRD + operator (recap of the decision)
- **One contract, many producers.** UI/API/MCP/GitOps all just produce an `App`. No producer
  needs to know how to assemble Deployments, Services, routing, and OIDC clients.
- **Self-healing.** The reconcile loop converges drift; restarts/upgrades are safe.
- **GitHub is optional, not required.** The apps-api writes CRs directly via a ServiceAccount
  (dynamic, no git). GitOps/ArgoCD is an opt-in path for teams who want their apps in version
  control. Both write the *same* CR; the operator doesn't care who wrote it.
- **Matches the most mature pack** (`nebari-llm-serving-pack` = CRD + Go operator + UI).

---

## 7. Authentication & Authorization

### Identities
- **Browser users (UI + the apps themselves):** standard Nebari Keycloak SSO. The UI is a
  `NebariApp` with `auth.enabled: true`; each launched app is likewise gated by its own
  `NebariApp` `SecurityPolicy` (unless `access.public`).
- **The MCP server / CLI / agents:** **Keycloak device authorization flow (RFC 8628)**. The
  nebari-operator already supports provisioning a **public device-flow client**. The agent runs
  the MCP tool, the MCP returns a verification URL + code, the user approves in a browser, and
  the MCP receives tokens. Tokens are cached locally (keyring) and refreshed.
- **apps-api ↔ Kubernetes:** the API runs with a ServiceAccount + RBAC scoped to create/patch
  `App` CRs (and read derived resources for observability) in managed namespaces.

### Authorization model
- **Who can launch / manage an app:** enforced by apps-api using the caller's Keycloak groups.
  An app's `access.groups`/`access.users` plus an `owner` field define management rights.
- **Who can *view/use* a running app:** enforced at the gateway by the `NebariApp`
  `SecurityPolicy` (`allowedGroups`) — same mechanism every Nebari app uses. `public: true`
  disables it for anonymous apps.
- **Namespaces as tenancy boundary:** apps live in project/team namespaces. The API maps a
  user's groups → permitted namespaces.

### Token flow for "agent generates → user launches"
1. Agent scaffolds the app (skill), commits the files or pushes them to git.
2. User: *"Launch the docs site in ./docs-site as a public app."*
3. MCP `launch_app` tool runs → if no valid token, returns a device-flow prompt → user
   approves → MCP calls `POST /apps` on apps-api with the bearer token.
4. apps-api validates the token + groups, writes the `App` CR, returns the (pending) app with
   its future URL. MCP reports status; `get_app_status` polls until `Running`.

---

## 8. The MCP Server (`apps-mcp`)

A **FastMCP** (Python) server running in-cluster as part of the pack, exposed as a `NebariApp`
(streamable HTTP). It is a **thin, well-described tool layer over apps-api** — it holds no
business logic of its own, so behavior stays consistent across UI/API/MCP.

### Tools
| Tool | Purpose | Maps to |
|---|---|---|
| `authenticate` | Start/refresh Keycloak device flow; return verification URL+code or confirm cached token. | Keycloak device endpoint |
| `describe_cluster` | Capabilities (apps domain, source types, launchable namespaces) so the agent picks valid options. | `GET /capabilities` |
| `launch_app` | Create + launch an app from NL-resolved params (name, source, access). | `POST /apps` |
| `list_apps` | List apps the caller can see (filter by namespace/owner/status). | `GET /apps` |
| `get_app` | Full spec + status + URL for one app. | `GET /apps/{id}` |
| `get_app_status` | Lightweight phase/replicas/url poll. | `GET /apps/{id}/status` |
| `get_app_logs` | Recent pod logs (optionally follow N lines). | `GET /apps/{id}/logs` |
| `update_app` | Patch an app (replicas, env, source ref, access). | `PATCH /apps/{id}` |
| `stop_app` / `start_app` | Scale to zero / back up. | `POST /apps/{id}:stop|start` |
| `remove_app` | Delete the app (cascades). | `DELETE /apps/{id}` |

### Design notes
- Tool descriptions are written for an LLM caller: each documents required vs. optional args
  and enumerates valid `source_type` values (`inline | git | pvc`).
- `launch_app` is **idempotent on `(namespace, name)`**: re-launching updates rather than
  duplicating, so an agent retrying is safe.
- All tools return structured JSON the agent can reason over (status, url, conditions, next
  actions like "approve device login at <url>").

---

## 9. REST API (`apps-api`)

FastAPI, async SQLAlchemy (for app metadata/audit/observability cache), pydantic v2,
structlog, OIDC bearer auth (validates Keycloak tokens; in-cluster + external issuer URLs).

### Endpoints (v1)
```
# Capabilities
GET    /capabilities                 # { appsDomain, sourceTypes, namespaces }

# App CRUD  (writes App CRs to the cluster)
GET    /apps                         # list (RBAC-filtered: namespace/owner/groups)
POST   /apps                         # create + launch  -> writes App CR
GET    /apps/{id}                    # full spec + status
PATCH  /apps/{id}                    # update spec (replicas, env, source, access)
DELETE /apps/{id}                    # delete (cascade)
POST   /apps/{id}:stop               # scale to zero
POST   /apps/{id}:start              # scale back up

# Observability
GET    /apps/{id}/status             # phase, replicas, url, conditions
GET    /apps/{id}/logs               # pod logs (query: lines, follow, container)
GET    /apps/{id}/events             # k8s events for the app's resources
GET    /apps/{id}/metrics            # cpu/mem (if metrics-server present)

# Auth
GET    /auth/device                  # initiate device flow (for MCP/CLI)
GET    /auth/me                      # current user + groups
```

### Request model (POST /apps) — ported & trimmed from jhub-apps
```jsonc
{
  "displayName": "Docs Site",
  "description": "Team documentation",
  "namespace": "team-analytics",
  "source": {
    "type": "git",
    "git": { "url": "...", "ref": "main", "subdir": "site" }
  },
  "runtime": { "env": [{ "name": "LOG_LEVEL", "value": "info" }], "replicas": 1 },
  "access": { "public": false, "groups": ["analytics"], "subdomain": "docs-site" },
  "thumbnail": "data:image/png;base64,..."   // optional
}
```
The API validates against `/capabilities`, applies RBAC, then renders and applies the `App`
CR. The DB stores a denormalized copy + audit log; live status is read back from the
CR/cluster (the CR remains source of truth, the DB is a cache + history).

---

## 10. The UI (`apps-ui`)

React + TS + Vite + shadcn/ui + Tailwind v4 (your frontend-dev conventions), TanStack Query +
Jotai, Keycloak via the standard Nebari SSO. Exposed as a `NebariApp`.

### Screens
1. **App catalog / dashboard** — grid of app cards (thumbnail, name, source type, status
   badge, owner, URL). Filter by status/owner/namespace. This is the landing experience.
2. **Launch form** (the `jhub-apps`-style flow, minus JupyterHub):
   - Name, description, thumbnail.
   - **Source**: tabs for *Upload* (a zip or a single `.html` file — rendered into the CR as
     `inline` or `pvc`) and *Git*.
   - **Resources** (cpu/mem/replicas) and **env vars** (key-value editor).
   - **Access**: public toggle, groups/users selector, subdomain.
   - Submit → `POST /apps` → redirect to the app detail page (spawn-pending → running).
3. **App detail / observability** — status + conditions timeline, live URL, **logs viewer**
   (streamed), **events**, metrics (cpu/mem), and edit/stop/start/delete actions.
4. **Edit** — same form pre-populated (maps to `PATCH /apps/{id}`).

The UI is deliberately a thin client over apps-api (same authority as MCP), so the launch
semantics are identical whether a human uses the form or an agent uses NL.

---

## 11. The Skill — Scaffolding Compatible Apps

A Claude Code skill (`/new-nebari-app` or similar) that an agent invokes to **generate** an app
in the exact layout the pack expects, so "generate → launch" is frictionless. (Lives alongside
your existing `new-frontend` / `new-backend` skills.)

### What it does
- Scaffolds a real `index.html` + assets and a **`nebari-app.yaml`** manifest (a thin,
  human-authored spec the API/MCP can consume directly — maps 1:1 to `App.spec`) whose source
  points at the local content directory:
  ```yaml
  # nebari-app.yaml  — sits next to index.html
  displayName: "Docs Site"
  source:
    type: files          # authoring convenience: a local directory of real files
    files: { path: "." }  # dir containing index.html, relative to this manifest
  access: { public: true, subdomain: "docs-site" }
  ```
  Manifest source types are `files | git | pvc`. On launch, the API/MCP/UI **bundles the
  referenced files** and renders them into the `App` CR as `source.type: inline` (small
  sites) or a provisioned `pvc` (large sites). So the author works with actual files, never
  hand-edited inline HTML; `inline`/`pvc`/`git` remain the on-cluster CR forms.
- Emits the **exact natural-language launch instruction** the user can hand to the MCP, e.g.:
  *"Launch the app in ./docs-site using nebari-app.yaml."* — the MCP reads
  `nebari-app.yaml` and calls `launch_app`.

### Why a manifest file
It bridges the agent and the launcher: the agent writes code + `nebari-app.yaml`; the MCP/API
read that manifest so there's no ambiguity translating NL → `App.spec`. It's also the GitOps
artifact if the team commits it.

---

## 12. Observability

- **Status:** every `App` publishes phase + conditions + URL; surfaced in UI, API, MCP.
- **Logs:** apps-api streams pod logs (k8s API) → UI logs viewer + MCP `get_app_logs`.
- **Events:** k8s events for the app's Deployment/Pods/NebariApp aggregated per app.
- **Metrics:** cpu/mem from metrics-server (if installed); optional ServiceMonitor for
  Prometheus to scrape app + operator metrics.
- **Operator metrics:** reconcile counts, errors, durations (controller-runtime defaults).
- **Audit:** apps-api records who launched/changed/removed each app (DB), exposed in detail view.

---

## 13. Security Considerations

- **Pod hardening:** non-root, drop capabilities, read-only root FS,
  seccomp `RuntimeDefault`, resource limits required (defaults applied if omitted).
- **Network:** default-deny `NetworkPolicy` per app namespace; app pods reach only what they
  need (DNS, declared egress).
- **Untrusted code:** apps run *user/agent-authored content*. Treat every app as untrusted:
  per-namespace tenancy, no cluster-admin tokens in app pods, no host mounts.
  Consider gVisor/Kata for stronger isolation (deferred).
- **Auth bypass paths:** only `access.public: true` apps skip SSO — flagged prominently in UI
  and require an explicit confirmation + (optionally) an admin-allowed group.
- **Secrets:** app env secrets via referenced k8s Secrets, never inlined in the CR; OIDC client
  secrets are operator-managed (nebari-operator) and mounted, not exposed via API.
- **MCP:** device-flow tokens scoped to the user's groups; the MCP cannot exceed the caller's
  RBAC because it always acts as the authenticated user against apps-api.

---

## 14. Packaging & Deployment

Follows the established pack convention (template: `nebari-llm-serving-pack`).

```
nebari-apps-pack/
  pack-metadata.yaml            # dashboard registration + nebariapp_integration: full
  charts/nebari-apps/
    Chart.yaml
    values.yaml                 # clusterDomain, gateways, keycloak, images
    crds/
      app-crd.yaml              # apps.nebari.dev/v1alpha1 App
    templates/
      operator-*.yaml           # operator Deployment + RBAC + (optional) webhook
      api-deployment.yaml
      api-service.yaml
      api-nebariapp.yaml        # exposes apps-api (auth on)
      ui-deployment.yaml
      ui-service.yaml
      ui-nebariapp.yaml         # exposes apps-ui (landing-page tile = "Apps")
      mcp-deployment.yaml
      mcp-service.yaml
      mcp-nebariapp.yaml        # exposes apps-mcp (device-flow client)
      namespace.yaml
      _helpers.tpl
  operator/                     # Go / kubebuilder
    api/v1alpha1/app_types.go
    internal/controller/app_controller.go
    internal/controller/reconcilers/{validate,workload,service,routing,status}/
    cmd/  Dockerfile  go.mod
  api/                          # FastAPI
    src/nebari_apps_api/  pyproject.toml  Dockerfile
  ui/                           # React + Vite
    src/  components.json  vite.config.ts  package.json  Dockerfile  nginx.conf
  mcp/                          # FastMCP
    src/nebari_apps_mcp/  pyproject.toml  Dockerfile
  skill/                        # the scaffolding skill
    SKILL.md  references/  assets/
  examples/                     # sample App CRs, ArgoCD Application
  docs/  README.md  LICENSE
```

- **Install:** Helm chart (or ArgoCD Application), parameterized with `clusterDomain`, gateway
  names/namespaces, and `keycloak.*`.
- **Prereqs:** nebari-operator (for `NebariApp`), Envoy Gateway + AI Gateway, cert-manager
  issuer, Keycloak realm, and a StorageClass (for `pvc` sources).
- **CRD lifecycle:** ship the `App` CRD in `charts/crds/` (or a separate ArgoCD-managed source).

---

## 15. Open Questions & Future Work

- **Scale-to-zero / idle reaping.** v1 = fixed `replicas` + manual stop/start. Future: KEDA or
  Knative for true scale-to-zero on idle (`keepAlive: false`). Decide whether the operator owns
  this or delegates.
- **Per-app custom domains** vs. subdomain-only — v1 is subdomain under cluster domain.
- **Sharing UX parity with jhub-apps** (revoke/re-grant flows) — model supports it; UI depth TBD.
- **App templates / marketplace** — a catalog of starter apps the UI/skill can clone.
- **Stronger sandboxing** (gVisor/Kata) for untrusted agent-generated content.
- **Resource quotas per namespace/group** — enforce launch limits.

---

## 16. Decisions Locked (from review)

| Decision | Choice | Rationale |
|---|---|---|
| Pod orchestration | **App CRD + Go operator** | One declarative contract for all producers; self-healing; GitHub optional (API writes CRs directly). |
| API / UI / MCP stack | **FastAPI + React + FastMCP (Python/TS)** | Reuse jhub-apps model + your frontend/backend skills; operator stays Go (matches nebari-operator). |
| Scope | **Static apps only** | Python services moved to `python-capability-pack` (2026-07-16); this pack stays a small, sharp tool for static content. |
| GitOps | **Optional, not required** | API writes CRs dynamically via ServiceAccount; ArgoCD path for teams who want version control. |
