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

> **Status: Alpha** (`level: alpha` in [`pack-metadata.yaml`](pack-metadata.yaml)) — installs
> and runs the happy path on a current Nebari dev cluster; APIs, chart values and the `App`
> CRD may still change between releases. Read [Known limitations](#known-limitations)
> before demoing. Implemented: the **`App` CRD** and **apps-operator** (static +
> Python/pixi apps from `inline`/`git`/`pvc` sources), the **apps-api** (CRUD,
> logs/events/status, analytics, zip/.html upload), the **apps-ui** (Nebari design system:
> dashboard + analytics, app detail with logs, launch form with upload), the **apps-mcp**
> server (agent tools + device-flow auth at `/mcp`), and the **`new-nebari-app` skill**
> (scaffold apps with a `nebari-app.yaml` manifest, then "launch it").
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

### Branding

The UI can be rebranded **without rebuilding the image** — title, logos, favicon, theme
colors, classification banners, and its landing-page tile. Set `ui.title` / `ui.branding.*`
in the chart (rendered into a `/config.json` ConfigMap the UI fetches at startup), or
`BRANDING_*` env vars when running the image standalone. This is the same contract used by
nebari-landing, llm-serving-pack, and provenance-collector-pack, so a fleet rebrands
uniformly. See the [Branding docs](https://packs.nebari.dev/apps-pack/branding/).

---

## Repository layout

```
apps-pack/
  pack-metadata.yaml          # dashboard registration
  charts/nebari-apps/         # Helm chart (App CRD + operator + api + ui + mcp)
  operator/                   # Go operator (controller-runtime)
  authz/                      # Go sidecar enforcing access.groups/users in app pods
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

- A Nebari cluster running the Nebari Infrastructure Core stack: **nebari-operator**
  `v0.1.0-alpha.20` or later (provides the `NebariApp` CRD; this is the version the pack's
  contract test and local dev loop pin), **Envoy Gateway** with the shared `public` (or
  `internal`) Gateway, a **Keycloak** realm (`nebari` by default), and **cert-manager** with a
  cluster issuer when TLS is enabled (the default).
- **Helm 3.8+** and `kubectl` with cluster-admin for the install (the chart creates a CRD and
  ClusterRoles).
- **Namespace opt-in:** the nebari-operator only reconciles namespaces labeled
  `nebari.dev/managed=true`. Label the release namespace and every namespace in
  `api.allowedNamespaces` (default `apps`).
- **Sizing:** the pack itself requests 300m CPU / 448Mi memory (limits 1.5 CPU / 896Mi)
  across its four pods. Each launched app adds a pod; an App that sets no `runtime.resources`
  gets the chart defaults (`apps.defaultResources`: 50m / 64Mi requested, up to 500m / 256Mi,
  for a static site; 250m / 512Mi requested, up to 2 CPU / 2Gi, for a Python app, whose cold
  `pixi install` needs the memory).
- **Optional:** metrics-server (per-app CPU/memory in the UI; the UI degrades gracefully
  without it) and the LGTM observability pack for logs.

---

## Known limitations

Alpha means the happy path works; these are the gaps to know about before a demo or pilot.

- **`access.groups` / `access.users` are enforced in the app pod, not at the gateway.** The
  nebari-operator SecurityPolicy only signs users in
  ([nebari-operator#153](https://github.com/nebari-dev/nebari-operator/issues/153)), so a
  private app that lists groups or users gets an authz sidecar that checks the forwarded
  access token and returns `403` to everyone else. Group changes apply when the user's token
  refreshes (5 minutes by default). A private app with neither list is open to any signed-in
  realm user, and `access.users` cannot hide the landing-page tile (the launch form's
  landing-page switch is locked until it can).
- **Authorization is owner-or-admin only.** The API lets a user see and manage only the
  Apps they launched; members of `api.adminGroups` manage all of them. There is no sharing
  or delegation yet, and anyone with `kubectl` access to an app namespace bypasses the API.
- **Inline sources are capped at ~900 KB of UTF-8 text** (a ConfigMap). Binary assets or
  larger sites need a `git` or `pvc` source.
- **No per-user quota.** Launched pods get default requests/limits and at most 10 replicas
  each, but nothing caps how many Apps one user launches. Add a `ResourceQuota` to app
  namespaces if that matters (the chart can render a `LimitRange` and a `NetworkPolicy`,
  `apps.limitRange` / `apps.networkPolicy`).
- **One API version (`v1alpha1`) and no conversion webhook** — a future schema change will
  require re-creating Apps. `helm upgrade` does not update CRDs; re-apply
  `charts/nebari-apps/crds/` by hand on upgrades.
- **The MCP server must run as a single replica**: device-flow sessions are held in process
  memory.
- **Landing-page tiles are off by default** for launched apps (`apps.landingPage.enabled`
  / `spec.landingPage.enabled`); only the pack's own "Apps" tile is registered.
- **Local dev disables authentication** (`api.auth.enabled=false`, with `tls.enabled=false`; the
  chart refuses to render it with TLS on unless `api.auth.insecureAllowAnonymous=true`); never carry that flag to
  a real cluster.

## Getting started

**On a Nebari cluster** (nebari-operator installed):

```bash
# App namespaces first: the chart grants the API a RoleBinding in each one
# listed in api.allowedNamespaces (default: apps).
kubectl create namespace apps && kubectl label namespace apps nebari.dev/managed=true
# From a checkout: the chart's default image tags are its appVersion, which
# only matches images at a release commit. On main, use the images main builds.
helm install nebari-apps charts/nebari-apps \
  --namespace nebari-apps --create-namespace \
  --set clusterDomain=<your-cluster-domain> \
  --set keycloak.url=https://keycloak.<your-cluster-domain>/auth \
  --set operator.image.tag=latest --set api.image.tag=latest \
  --set ui.image.tag=latest --set mcp.image.tag=latest
kubectl label namespace nebari-apps nebari.dev/managed=true
```

Or install from the published chart with the ready-made values file
([`examples/nebari-values.yaml`](examples/nebari-values.yaml) — only the two hostnames need
editing):

```bash
helm install nebari-apps oci://ghcr.io/nebari-dev/apps-pack/charts/nebari-apps \
  --namespace nebari-apps --create-namespace -f examples/nebari-values.yaml
```

With GitOps, apply the Argo CD `Application` in
[`examples/argocd-application.yaml`](examples/argocd-application.yaml) instead: it installs the same published chart
with the same values (edit the two hostnames and `targetRevision`).

```bash
kubectl apply -n argocd -f examples/argocd-application.yaml
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

## Releases

Images are built by [`images.yaml`](.github/workflows/images.yaml) through the
org's reusable `pack-build-image` workflow. Every merge to `main` pushes all five images
(`apps-operator`, `apps-authz`, `apps-api`, `apps-ui`, `apps-mcp`) to `ghcr.io/nebari-dev/apps-pack/<image>`
and `quay.io/nebari/apps-pack-<image>`, tagged `sha-<short>`, and signs each one keyless
with cosign, with a build-provenance attestation and an SBOM. The same push also moves
`latest`, which tracks `main` and is for development only: deploy a released chart, which
pins exact `sha-` tags. Pull requests build each image once (amd64, without pushing) and
scan it with Trivy; a HIGH or CRITICAL vulnerability with an available fix fails the check.

**Releasing is merging the release PR.**
[`release-pr.yaml`](.github/workflows/release-pr.yaml) keeps one open
`chore: release X.Y.Z` pull request, opened by
[release-please](https://github.com/googleapis/release-please). It bumps every version string
together (Chart `version` and `appVersion`, the api and mcp `__version__`, `ui/package.json`
and its lockfile) and adds the release's section to [`CHANGELOG.md`](CHANGELOG.md), written
from the conventional-commit titles of the PRs merged since the last release (`feat:` → minor
while we are below 1.0, `fix:` → patch). A CI check fails if those strings ever disagree with
[`.release-please-manifest.json`](.release-please-manifest.json). Without a
`RELEASE_PLEASE_TOKEN` secret, the release PR is opened with `GITHUB_TOKEN` and its checks do
not start until a maintainer closes and reopens it.

Merging it changes `version` in
[`charts/nebari-apps/Chart.yaml`](charts/nebari-apps/Chart.yaml), which runs
[`release.yaml`](.github/workflows/release.yaml). That uses the org's `pack-release`
workflow to:

- pin the chart's five image tags to `sha-<release commit>` (those images are built by the
  same push),
- sign the packaged chart and attach it to a GitHub Release `nebari-apps-<version>`,
- open a PR in [nebari-dev/helm-repository](https://github.com/nebari-dev/helm-repository),
  which publishes the chart to the org Helm repo once merged, and
- mirror the same chart to `oci://ghcr.io/nebari-dev/apps-pack/charts`.

Install a released version from the OCI mirror:

```bash
helm install nebari-apps oci://ghcr.io/nebari-dev/apps-pack/charts/nebari-apps \
  --version <X.Y.Z> \
  --namespace nebari-apps --create-namespace \
  --set clusterDomain=<your-cluster-domain> \
  --set keycloak.url=https://keycloak.<your-cluster-domain>/auth
```

A running install reports its version and image build at `GET /api/v1/version`
(`{"version": "0.2.0", "build": "sha-abc1234"}`), and the UI shows it at the bottom of the
account menu. Include it in bug reports.

To check an image's or chart's signature, see
[Verifying Nebari pack artifacts](https://github.com/nebari-dev/.github/blob/main/verifying-nebari-artifacts.md).
The signer identity is the org workflow at the commit this repo pins
(`nebari-dev/.github/.github/workflows/pack-build-image.yaml@a6c757c72124a03542a79ac5385fd250ee9c45b7`).

## Documentation

The user guide lives at **[packs.nebari.dev/apps-pack](https://packs.nebari.dev/apps-pack/)**
(an [Astro Starlight](https://starlight.astro.build/) site in [`docs/`](docs/); run it locally
with `cd docs && bun install && bun run dev`):

- Getting started, launching apps (UI / upload / API / kubectl), the **MCP server**
  (connecting agents, device-flow auth, tool list), the scaffolding skill, and local
  development
- Operating it: [troubleshooting](https://packs.nebari.dev/apps-pack/troubleshooting/),
  [upgrading](https://packs.nebari.dev/apps-pack/upgrading/) (CRD re-apply, backups,
  rollback) and [CI/CD & releasing](https://packs.nebari.dev/apps-pack/ci-cd/)
- Reference: chart configuration (every value and the `NebariApp` fields the chart
  emits), the App CRD, the REST API, and architecture & auth

Historical design documents stay in the repository; they are not maintained, and the docs
site is authoritative where they differ:

- [`docs/DESIGN.md`](docs/DESIGN.md) — the original design document.
- [`docs/PLAN.md`](docs/PLAN.md) — the phased implementation plan and its risks.
- [software-pack-template](https://github.com/nebari-dev/software-pack-template) — pack
  conventions and the `NebariApp` CRD reference this pack builds on.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for the development loop, the checks each component
must pass, and pull request conventions. Participation is governed by the
[Code of Conduct](CODE_OF_CONDUCT.md); report security issues as described in
[SECURITY.md](SECURITY.md).

## License

[Apache License 2.0](LICENSE).
