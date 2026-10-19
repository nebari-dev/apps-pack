# Contributing to the Nebari Apps Pack

Thanks for helping out. This pack follows the Nebari community's
[contribution guidelines](https://www.nebari.dev/docs/community) and
[Code of Conduct](CODE_OF_CONDUCT.md). This file covers what is specific to this
repository.

Security problems are not reported here: see [SECURITY.md](SECURITY.md).

Using a coding agent? [AGENTS.md](AGENTS.md) has the repo map, commands and invariants it
needs; keep it current when you change any of them (CI checks the paths it names).

## Before you start

- **Open or find an issue first** for anything bigger than a typo, so the approach can be
  agreed before you write the code. Use the bug or feature form.
- The `App` CRD (`operator/api/`), the Helm chart (`charts/`) and CI (`.github/`) have
  [code owners](CODEOWNERS) who are requested on every change there.

## Development loop

The `dev/` Makefile brings up a kind cluster with the full Nebari stack (Envoy Gateway,
cert-manager, Keycloak, nebari-operator) and every pack component. See
[Local development](https://packs.nebari.dev/apps-pack/local-development/) for the
details.

```bash
cd dev
make up          # cluster + operator + api + ui + mcp + example app
make redeploy    # rebuild every image and roll the Deployments after a change
make down        # delete the cluster
```

The repository layout is described in the [README](README.md#repository-layout).

## Quality gates

CI runs these on every pull request. Run the ones for the components you touched before
pushing.

| Component | Directory | Checks |
|---|---|---|
| Operator (Go) | `operator/` | `go vet ./...`, `go build ./...`, `go test ./... -race`, `golangci-lint run` (config in `operator/.golangci.yml`) |
| CRD / deepcopy | `operator/` | Regenerate with `controller-gen` v0.21.0 (commands below) and commit the result; CI fails on drift. |
| apps-api | `api/` | `uv lock --check`, `uv sync --frozen --extra dev`, `uv run --frozen --no-sync python -m pytest -q`, then `ruff check .`, `ruff format --check .` and `mypy` (strict) through `uv run --frozen --no-sync` |
| apps-mcp | `mcp/` | Same as apps-api, plus `uv pip install --no-deps -e ../api` before the tests (they drive the real API in process). |
| apps-ui | `ui/` | `npm ci`, `npm run check:ci` (Biome lint and format; `npm run check` applies fixes), `npm run build`, `npm run size` (bundle budget, below), `npm test` |
| Helm chart | `charts/nebari-apps/` | `helm lint charts/nebari-apps --set clusterDomain=nebari.example.com`, and `helm template` with `examples/nebari-values.yaml` |
| Docs | `docs/` | `bun install --frozen-lockfile`, `bun test test`, `bun run build` |
| Dependencies | `api/`, `mcp/`, `ui/` | `pip-audit` over the locked Python deps, `npm audit --audit-level=high` |
| Workflows | `.github/workflows/` | `actionlint` and `zizmor .github/workflows` (config in `.github/zizmor.yml`). Pin every action to a full commit SHA with a `# vX.Y.Z` comment (Dependabot keeps them current), and give each workflow `permissions: contents: read`, widening per job only where needed. |

Runtime versions are pinned once and read everywhere: `ui/.node-version`, `api/.python-version`
and `mcp/.python-version` (CI's setup-node and uv read them), `docs/.bun-version`, and the
`toolchain` line in `operator/go.mod`. Base images are pinned by digest. When you change a
runtime version, change the pin file and the matching Dockerfile `FROM` in the same PR; the
Runtime pins check in CI fails when they disagree.

The UI has a bundle budget: `npm run size` gzips what the browser loads before first paint
(the entry script and everything `dist/index.html` preloads) and all JS, and fails when either
is over `bundleBudget` in `ui/package.json` (kB, gzip; 195 initial and 240 total today, about
5% above the current build). Pages load on first visit (`React.lazy` in `src/main.tsx`) and
keycloak-js only when auth is on, so new page code rarely touches the initial number. If it
goes over, move the code out of the initial load before raising the budget.

Regenerating the CRD after changing `operator/api/`:

```bash
cd operator
go install sigs.k8s.io/controller-tools/cmd/controller-gen@v0.21.0
controller-gen object paths="./api/..."
controller-gen crd paths="./api/..." output:crd:artifacts:config=../charts/nebari-apps/crds
```

Python dependencies are managed with [uv](https://docs.astral.sh/uv/), and `uv.lock` is the
source of truth. Change a dependency in `pyproject.toml`, then run `uv lock` and commit both.

## Pull requests

- **Title:** a [Conventional Commit](https://www.conventionalcommits.org/) subject, such as
  `fix(api): reject empty subdomains` or `feat(operator): add a pvc source`. Pull requests
  are squash-merged, so the title becomes the commit on `main`.
- **Link the issue** with `Closes #<number>` in the description. That closes the issue
  on merge and moves it on the project board.
- **Keep the docs in step.** User-visible behavior is documented in `docs/` (the site),
  `README.md`, and, for anything an agent drives, `skill/`. Update them in the same PR.
- **Say how you tested it**, including on a cluster when the change touches the operator,
  the chart, or auth.
- Keep a PR to one change. Unrelated cleanups go in their own PR.

## Releases

Releases are cut by maintainers; see [Releases](README.md#releases).
