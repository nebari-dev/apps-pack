# Nebari Apps Pack

A [Nebari](https://nebari.dev) Software Pack for launching, managing, and observing **web
applications** on a Nebari Kubernetes cluster — both **static** sites and **Python** apps
(Streamlit, Panel, Gradio, Dash, Voila, FastAPI, custom) — behind Keycloak SSO.

Apps can be launched four ways, all converging on a single declarative `App` resource:

- 🤖 **A coding agent** (Claude Code, Codex) generates an app, then you **launch it with natural
  language** through an in-cluster **MCP server**.
- 🔧 **The MCP server** directly (launch / list / access / remove / logs as agent tools).
- 🌐 **A REST API** for programmatic CRUD + observability.
- 🖥️ **A form-based UI** directly from the dashboard ui.

Python apps run inside **pixi environments** managed by [Nebi](https://nebi.nebari.dev/) and
delivered as OCI artifacts.

> **Status:** Design phase. See [`docs/DESIGN.md`](docs/DESIGN.md) and
> [`docs/PLAN.md`](docs/PLAN.md). No runtime code yet.

---

## How it works

Every producer — agent/MCP, API, UI, or (optional) GitOps — writes the same **`App` custom
resource** (`apps.nebari.dev/v1alpha1`). The **apps-operator** reconciles it into a Deployment +
Service + a `NebariApp`; the existing [nebari-operator](https://github.com/nebari-dev/nebari-operator) turns that
`NebariApp` into routing (HTTPRoute), TLS (cert-manager), **Keycloak SSO**, and a landing-page
tile.

```
agent/MCP ─┐
REST API ──┤                          ┌─ Deployment (app pod) ─ pulls pixi env (Nebi OCI)
UI ────────┼─►  App CR  ─► apps-      ─┼─ Service
GitOps ────┘  (one         operator    └─ NebariApp ─► nebari-operator ─► HTTPRoute + TLS
              contract)                                                   + Keycloak + tile
```

The **apps-api is the single authority** — the UI and MCP are thin clients over it, so launch
semantics are identical whether a human uses the form or an agent uses natural language. The API
writes `App` CRs directly via a ServiceAccount, so **GitHub/GitOps is optional, not required**.

---

## Components

| Component | Stack | Responsibility |
|---|---|---|
| **App CRD** | `apps.nebari.dev/v1alpha1` | The declarative contract for an app. |
| **apps-operator** | Go + kubebuilder | Reconcile `App` → Deployment, Service, `NebariApp`, status. |
| **apps-api** | Python / FastAPI | CRUD + observability; writes `App` CRs; queries Nebi. |
| **apps-ui** | React + TS + Vite + shadcn/ui | Form-based launch + management + observability. |
| **apps-mcp** | Python / FastMCP | Agent-facing tools; Keycloak device-flow auth. |
| **skill** | Claude Code skill | Scaffold static/Python apps in the expected layout. |

---

## Repository layout

```
nebari-apps-pack/
  pack-metadata.yaml          # dashboard registration
  charts/nebari-apps/         # Helm chart (CRD + operator + api + ui + mcp + NebariApps)
  operator/                   # Go / kubebuilder operator
  api/                        # FastAPI backend
  ui/                         # React frontend
  mcp/                        # FastMCP server
  skill/                      # app-scaffolding skill
  examples/                   # sample App CRs, ArgoCD Application
  docs/
    DESIGN.md                 # comprehensive design document
    PLAN.md                   # phased implementation plan
```

---

## Quick examples

### Static web app

Keep real files on disk and launch the directory — no git or external source. A project looks
like:

```
docs-site/
  nebari-app.yaml      # the launch manifest
  index.html           # your actual content (plus any css/js/assets)
```

`nebari-app.yaml` points at the local content directory:

```yaml
displayName: "Docs Site"
framework: static
source:
  type: files
  files:
    path: .            # directory containing index.html, relative to this manifest
access:
  public: true
  subdomain: docs-site
```

Launch it — the API/MCP/UI bundles the local files and creates the `App` for you:

```bash
# via CLI/API
POST /apps  (multipart: nebari-app.yaml + the files)
# or just tell the MCP: "launch the app in ./docs-site"
```

> On the cluster the bundled files become the `App`'s materialized source (a ConfigMap-backed
> volume for small sites, or a PVC for larger ones). Static apps can also be sourced directly
> from a PVC (`type: pvc`) or a git repo (`type: git`).

### Python app

An `App` custom resource:

```yaml
apiVersion: apps.nebari.dev/v1alpha1
kind: App
metadata:
  name: sales-dashboard
  namespace: team-analytics
spec:
  displayName: "Sales Dashboard"
  framework: streamlit
  source:
    type: ociEnv
    ociEnv:
      ref: "oci://quay.io/nebari/envs/team-analytics/ds-stack:v3"
      code: { type: git, git: { url: "https://github.com/...", ref: "main", subdir: "app" } }
      entrypoint: "app.py"
  access:
    public: false
    groups: ["analytics"]
    subdomain: sales-dashboard
```

`kubectl apply` it (or `POST /apps`, or ask the MCP to "launch it") → reachable at
`https://sales-dashboard.<cluster-domain>` behind Keycloak SSO.

---

## Prerequisites

- A Nebari cluster with **nebari-operator** (provides the `NebariApp` CRD), Envoy Gateway +
  AI Gateway, cert-manager issuer, and a Keycloak realm.
- A StorageClass and an OCI registry.
- **Nebi** is **optional** — static apps and an inline-pixi fallback work without it; full
  environment management delegates to Nebi when present.

---

## Documentation

- [`docs/DESIGN.md`](docs/DESIGN.md) — architecture, the `App` CRD, workload model, pixi/Nebi
  integration, Keycloak auth, MCP tools, REST API, UI, the skill, observability, and security.
- [`docs/PLAN.md`](docs/PLAN.md) — phased implementation roadmap and risks.

## License

[Apache License 2.0](LICENSE).
