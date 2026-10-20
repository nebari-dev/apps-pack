# AGENTS.md

Instructions for coding agents working in this repository. Humans should start with
[`README.md`](README.md) and [`CONTRIBUTING.md`](CONTRIBUTING.md); this file adds the
invariants and pitfalls an agent would otherwise have to rediscover.

## What this is

The Nebari Apps Pack launches web apps on a Nebari cluster. **One contract, many
producers:** the UI, the REST API, the MCP server and `kubectl`/GitOps all write the same
`App` custom resource (`apps.nebari.dev/v1alpha1`), and only the operator turns an App into
workloads (Deployment, Service, ConfigMap) plus a `NebariApp` that the
[nebari-operator](https://github.com/nebari-dev/nebari-operator) turns into routing, TLS and
Keycloak auth. See [`docs/src/content/docs/architecture.md`](docs/src/content/docs/architecture.md).

## Repository map

| Path | What | Key files |
|---|---|---|
| `operator/` | Go operator (controller-runtime) | `api/v1alpha1/app_types.go` (the CRD), `internal/controller/app_controller.go` (reconcile pipeline), `internal/controller/workload.go` (pod spec), `internal/controller/authz.go` (the authz sidecar for Apps with groups/users), `internal/controller/sources.go` (source volumes and init containers), `internal/controller/routing.go` (NebariApp) |
| `authz/` | Go sidecar: verifies the forwarded access token and enforces `access.groups`/`access.users` (403 otherwise) | `main.go` (env config), `internal/gate/verify.go` (token checks), `internal/gate/proxy.go` (proxy + probes) |
| `api/` | FastAPI REST API over App CRs | `src/nebari_apps_api/main.py` (routes), `auth.py` (JWT + owner/admin checks), `models.py` (request/response models), `cr.py` (model ↔ CR), `k8s.py` (store) |
| `mcp/` | FastMCP server, agent tools at `/mcp` | `src/nebari_apps_mcp/server.py` (tools), `auth.py` (device flow, sessions), `untrusted.py` (fencing app output) |
| `ui/` | React + Vite UI on the Nebari design registry | `src/pages/`, `src/components/` (`app-form/`: state, sections), `src/hooks/use-app-actions.ts`, `src/lib/api.ts`, `src/lib/types.ts` (over the generated `crd.gen.ts`) |
| `charts/nebari-apps/` | Helm chart: CRD, operator, api, ui, mcp | `values.yaml`, `templates/`, `crds/apps.nebari.dev_apps.yaml` (generated) |
| `skill/new-nebari-app/` | Claude Code skill that scaffolds an app + launch manifest | `SKILL.md`, `references/manifest.md` |
| `examples/` | Sample App CRs, Helm values, Argo CD Application | `README.md` |
| `docs/` | Astro Starlight site (packs.nebari.dev/apps-pack) | `src/content/docs/` |
| `dev/` | kind cluster with the full Nebari stack | `Makefile` |

## Commands

Run the checks for every component you touched; CI runs all of them
([quality gates](CONTRIBUTING.md#quality-gates) has the full table).

```bash
# operator/ (authz/ is the same)
go build ./... && go vet ./... && go test ./... -race && golangci-lint run

# api/  (mcp/ is the same, plus `uv pip install --no-deps -e ../api` before pytest)
uv sync --frozen --extra dev
uv run --frozen --no-sync python -m pytest -q
uv run --frozen --no-sync ruff check . && uv run --frozen --no-sync ruff format --check . && uv run --frozen --no-sync mypy

# ui/
npm ci && npm run check:ci && npm run build && npm test
npm run test:e2e   # Playwright + axe on the build (once: npx playwright install chromium)

# docs/
bun install --frozen-lockfile && bun test test && bun run build

# chart
helm lint charts/nebari-apps --set clusterDomain=nebari.example.com
```

## Invariants

- **The CRD is generated.** Edit `operator/api/v1alpha1/app_types.go`, then run
  `controller-gen` (commands in CONTRIBUTING) and commit `operator/api/v1alpha1/zz_generated.deepcopy.go`
  and `charts/nebari-apps/crds/apps.nebari.dev_apps.yaml`, then run
  `python3 .github/scripts/gen_crd_types.py` to regenerate `ui/src/lib/crd.gen.ts` (the UI's App
  types derive from it). CI fails on drift in all three. A new spec field also has to be added by
  hand to `api/src/nebari_apps_api/models.py` (`api/tests/test_crd_conformance.py` fails until it
  is) and `cr.py`, the MCP `launch_app` arguments, `skill/new-nebari-app/references/manifest.md`
  and `docs/src/content/docs/app-crd-reference.md`.
- **The NebariApp shape is a pinned contract** (nebari-operator `v0.1.0-alpha.20`, pinned once in
  `.nebari-operator-version` and mirrored by `NebariOperatorContract` in `routing.go`), guarded by
  `operator/internal/controller/nebariapp_contract_test.go`. Do not change emitted fields
  without updating that test and the "NebariApp fields the chart emits" table in
  `docs/src/content/docs/configuration.md`.
- **Every per-App API route authorizes through `authorized_app`** (owner or an
  `api.adminGroups` member). `api/tests/test_authz.py` enumerates the routes and fails when a
  new one has no authorization case; add it there.
- **App pods are untrusted user code.** Keep them non-root, capability-free, without a
  ServiceAccount token, and with resource limits. User input reaches init containers through
  environment variables, never shell interpolation. The `app` container stays first and
  keeps its name (logs default to it); restricted Apps add the `authz` sidecar after it. MCP tools return app-controlled text
  (logs, files) only through the fences in `mcp/src/nebari_apps_mcp/untrusted.py`.
- **Version strings are owned by release-please.** Never hand-edit the version in
  `charts/nebari-apps/Chart.yaml`, the `__version__` files, or `ui/package.json`; the
  "Version strings" check compares them with `.release-please-manifest.json`.
- **Runtime versions are pinned once:** `ui/.node-version`, `api/.python-version`,
  `mcp/.python-version`, `docs/.bun-version`, and the `toolchain` line in `operator/go.mod`
  (`authz/go.mod` carries the same line).
  Change the pin and the matching Dockerfile `FROM` (digest-pinned) together.
- **Workflows:** every `uses:` is pinned to a full commit SHA with a `# vX.Y.Z` comment;
  each workflow starts at `permissions: contents: read`. actionlint and zizmor run in the
  `repo` job of `.github/workflows/ci.yaml` on every PR.

## Don't

- Don't hand-edit `ui/src/components/ui/*`. Those files come from the `@nebari` shadcn
  registry (`ui/components.json`); reinstall with `npx shadcn add @nebari/<item> --overwrite`,
  and put app-specific variations in `ui/src/components/`. The vendored design-system skill at
  `ui/.claude/skills/nebari-ui/SKILL.md` is a registry copy too
  (`npx shadcn add @nebari/claude-skill --overwrite` from `ui/`).
- Don't edit `uv.lock` or `package-lock.json` by hand; change `pyproject.toml` or
  `package.json` and relock (`uv lock`, `npm install`).
- Don't add a version, image tag or `latest` default to the chart's `values.yaml`; released
  charts pin `sha-` tags.
- Don't widen RBAC in `charts/nebari-apps/templates/` without saying why in the PR; the API
  is namespaced by design (`api.allowedNamespaces`).

## Pull requests

Conventional Commit titles (`feat(api): …`, `fix(operator): …`), squash-merged; they become
the CHANGELOG. Link the issue with `Closes #N`, update `docs/`, `README.md` and `skill/` for any
user-visible change, and say how it was tested (on a cluster for operator, chart or auth
changes).
