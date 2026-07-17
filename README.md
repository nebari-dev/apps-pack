# Nebari Apps Pack

A [Nebari](https://nebari.dev) Software Pack for launching, managing, and observing **web
apps** on a Nebari Kubernetes cluster, behind Keycloak SSO. Two kinds of app are
supported: **static sites** (HTML/CSS/JS, served by nginx) and **Python apps** launched
by a [pixi](https://pixi.sh) task — upload a zip with a `pixi.toml` and your source, name
the task, and the pack runs it. No Dockerfile, no image build.

Apps can be launched four ways, all converging on a single declarative `App` resource:

- 🖥️ **A form-based UI** — dashboard with analytics, app detail with logs/events, a launch
  form, and direct **zip/.html upload**.
- 🌐 **A REST API** for programmatic CRUD + observability.
- 🤖 **A coding agent** (Claude Code, Codex) — connect to the in-cluster **MCP server** at
  `https://apps.<cluster-domain>/mcp` and **launch with natural language**.
- 🔧 **The MCP server** directly (launch / list / status / logs / update / stop / remove as
  agent tools; Keycloak device-flow auth).

> **Status:** In development. Implemented so far: the **`App` CRD** and
> **apps-operator** (static + Python/pixi apps from `inline`/`git`/`pvc` sources), the
> **apps-api** (CRUD, logs/events/status, analytics, zip/.html upload), the
> **apps-ui** (Nebari design system: dashboard + analytics, app detail with
> logs, launch form with upload), the **apps-mcp** server (agent tools +
> device-flow auth at `/mcp`), and the **`new-nebari-app` skill** (scaffold
> apps with a `nebari-app.yaml` manifest, then "launch it").
> Apps are served at `https://<subdomain>.apps.<cluster-domain>` (TLS can be
> switched off via `tls.enabled=false`, as local dev does).

---

## How it works

Every producer — agent/MCP, API, UI, or (optional) GitOps — writes the same **`App` custom
resource** (`apps.nebari.dev/v1alpha1`). The **apps-operator** reconciles it into a Deployment +
Service + a `NebariApp`; the existing [nebari-operator](https://github.com/nebari-dev/nebari-operator) turns that
`NebariApp` into routing (HTTPRoute), TLS (cert-manager), **Keycloak SSO**, and a landing-page
tile.

```
UI ────────┐
REST API ──┤                          ┌─ Deployment (app pod)
agent/MCP ─┼─►  App CR  ─► apps-      ─┼─ Service
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
| **apps-operator** | Go + controller-runtime | Reconcile `App` → Deployment, Service, `NebariApp`, status. |
| **apps-api** | Python / FastAPI | CRUD + observability + zip/.html upload; writes `App` CRs. |
| **apps-ui** | React + TS + Vite + [nebari-design](https://github.com/nebari-dev/nebari-design) | Dashboard + analytics, launch form, app detail with logs/events. |
| **apps-mcp** | Python / FastMCP | Agent-facing tools at `/mcp`; Keycloak device-flow auth. |
| **skill** | Claude Code skill | Scaffold static apps + `nebari-app.yaml`; "launch it" via the MCP. |

### Authentication model

- **apps-ui / apps-api** — the UI logs in with **keycloak-js** (SPA PKCE flow against a public
  client its `NebariApp` provisions) and calls the API with a **JWT bearer token**, which the
  API validates against the realm JWKS.
- **Launched apps** — no auth code at all: private apps are enforced **at the gateway** by the
  `SecurityPolicy` their `NebariApp` creates; `access.public: true` skips it.

---

## Repository layout

```
nebari-apps-pack/
  pack-metadata.yaml          # dashboard registration
  charts/nebari-apps/         # Helm chart (App CRD + operator + api + ui + mcp)
  operator/                   # Go operator (controller-runtime)
  api/                        # FastAPI backend (CRUD + observability + upload)
  ui/                         # React frontend (Nebari design system)
  mcp/                        # FastMCP server (agent tools at /mcp)
  skill/                      # new-nebari-app scaffolding skill (Claude Code)
  dev/                        # local dev loop (kind + full Nebari stack)
  examples/                   # sample App CRs
  docs/                       # user guide (Astro Starlight → packs.nebari.dev)
    src/content/docs/         # guide pages (getting started, MCP, skill, references)
    DESIGN.md                 # comprehensive design document
    PLAN.md                   # phased implementation plan
```

---

## Quick examples

### Static web app — upload it

Zip your site (or take a single `.html` file) and upload it from the UI's launch form, or via
the API:

```bash
curl -X POST https://apps.<cluster-domain>/api/v1/apps/upload \
  -H "Authorization: Bearer $TOKEN" \
  -F 'manifest={"name":"docs-site","namespace":"apps","displayName":"Docs Site",
                "access":{"public":true,"subdomain":"docs-site"}}' \
  -F "file=@site.zip"
```

> The uploaded files become the `App`'s inline source, materialized on the cluster as a
> ConfigMap-backed volume (text assets, ~900KB cap — use a `git` or `pvc` source for larger
> sites). An archive needs an `index.html` at its root.

Or write the `App` CR yourself — static apps can be sourced from `inline` files, a `git`
repository (cloned by an init container), or an existing `pvc`:

```yaml
apiVersion: apps.nebari.dev/v1alpha1
kind: App
metadata:
  name: team-site
spec:
  displayName: "Team Site"
  source:
    type: git
    git: { url: "https://github.com/org/site", ref: "main", subdir: "public" }
  access:
    public: false
    groups: ["analysts"]
    subdomain: team-site
```

`kubectl apply` it (or `POST /api/v1/apps`, or use the UI's launch form) → reachable at
`https://team-site.apps.<cluster-domain>` behind Keycloak SSO.

### Agent flow — generate, then "launch it"

Install the scaffolding skill and connect the MCP server:

```bash
cp -r skill/new-nebari-app .claude/skills/     # or ~/.claude/skills/
claude mcp add --transport http nebari-apps https://apps.<cluster-domain>/mcp
```

Then, in Claude Code:

> **You:** create a public static site called release-notes
> *(the skill scaffolds `release-notes/` with real files + `nebari-app.yaml`)*
> **You:** launch it
> *(the agent reads the manifest, calls `launch_app`, polls status, and replies with
> `https://release-notes.apps.<cluster-domain>`)*

The manifest maps 1:1 onto `App.spec`, so the same directory works with the UI's upload
form, the API, or GitOps.

---

## Prerequisites

- A Nebari cluster with **nebari-operator** (provides the `NebariApp` CRD), Envoy Gateway,
  cert-manager issuer (only when TLS is enabled), and a Keycloak realm.

---

## Getting started

**On a Nebari cluster** (nebari-operator installed):

```bash
helm install nebari-apps charts/nebari-apps \
  --namespace nebari-apps --create-namespace \
  --set clusterDomain=<your-cluster-domain> \
  --set keycloak.url=https://keycloak.<your-cluster-domain>/auth
kubectl label namespace nebari-apps nebari.dev/managed=true
```

The UI lands at `https://apps.<your-cluster-domain>` (keycloak-js SSO) with the
MCP endpoint at `https://apps.<your-cluster-domain>/mcp`; every launched app
gets `https://<name>.apps.<your-cluster-domain>` with auth enforced at the
gateway. Connect a coding agent:

```bash
claude mcp add --transport http nebari-apps https://apps.<your-cluster-domain>/mcp
```

Apps can also be applied directly:

```bash
kubectl label namespace <your-namespace> nebari.dev/managed=true
kubectl apply -n <your-namespace> -f examples/static-inline-app.yaml
kubectl get apps -n <your-namespace> -w   # wait for Phase=Running, then open the URL
```

**Locally** (kind + the full Nebari stack, ~5–10 min first run):

```bash
cd dev
make up          # cluster + operator + api + ui + mcp + example app (plain HTTP, no auth)
open http://apps.nebari.test              # the UI
open http://docs-site.apps.nebari.test    # the example app
```

No port-forwarding or `/etc/hosts` edits: a local wildcard-DNS container resolves
`*.nebari.test` to `127.0.0.1` (one-time `/etc/resolver` file on macOS, offered by `make up`),
and the kind cluster maps host port 80 straight to the gateway, so every launched app is
reachable as soon as its route reconciles. Type the `http://` scheme explicitly: browsers
auto-upgrade bare hostnames to https, which is disabled locally. See the
[local development guide](docs/src/content/docs/local-development.md) for the full dev loop.

## Documentation

The user guide lives at **[packs.nebari.dev/nebari-apps-pack](https://packs.nebari.dev/nebari-apps-pack/)**
(an [Astro Starlight](https://starlight.astro.build/) site in [`docs/`](docs/); run it locally
with `cd docs && bun install && bun run dev`):

- Getting started, launching apps (UI / upload / API / kubectl), the **MCP server**
  (connecting agents, device-flow auth, tool list), the scaffolding skill, and local
  development
- Reference: the App CRD, the REST API, and architecture & auth

Design documents stay in the repository:

- [`docs/DESIGN.md`](docs/DESIGN.md) — the comprehensive design document.
- [`docs/PLAN.md`](docs/PLAN.md) — phased implementation roadmap and risks.
- [software-pack-template](https://github.com/nebari-dev/software-pack-template) — pack
  conventions and the `NebariApp` CRD reference this pack builds on.

## License

[Apache License 2.0](LICENSE).
