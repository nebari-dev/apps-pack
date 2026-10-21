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

The repository layout is described in [AGENTS.md](AGENTS.md#repository-map).

## Quality gates

CI runs these on every pull request. Run the ones for the components you touched before
pushing.

CI is one job per component in `.github/workflows/ci.yaml` (Operator, Authz sidecar, Python
per package, UI, Helm chart, Repo invariants), plus `.github/workflows/images.yaml`, which builds each
image. The checks that are scripts live in `.github/scripts/` and run locally from the repo
root, e.g. `python3 .github/scripts/check_versions.py` or
`python3 .github/scripts/check_doc_paths.py` (the chart checks need PyYAML and a rendered
chart; see the `chart` job for the arguments).

| Component | Directory | Checks |
|---|---|---|
| Operator (Go) | `operator/` | `go vet ./...`, `go build ./...`, `go test ./... -race` (CI also enforces an `internal/` coverage floor, in `.github/workflows/ci.yaml`), `golangci-lint run` (config in `operator/.golangci.yml`), and the envtest suite (below) |
| Authz sidecar (Go) | `authz/` | `go mod tidy -diff`, `go vet ./...`, `go build ./...`, `golangci-lint run` (config in `authz/.golangci.yml`), `go test ./... -race` with an `internal/` coverage floor (in `.github/workflows/ci.yaml`); the tests mint tokens against a fake JWKS |
| CRD / deepcopy | `operator/` | Regenerate with `controller-gen` v0.21.0 (commands below) and commit the result; CI fails on drift. |
| apps-api | `api/` | `uv lock --check`, `uv sync --frozen --extra dev`, `uv run --frozen --no-sync python -m pytest -q --cov` (fails under `fail_under` in `pyproject.toml`), then `ruff check .`, `ruff format --check .` and `mypy` (strict) through `uv run --frozen --no-sync` |
| apps-mcp | `mcp/` | Same as apps-api, plus `uv pip install --no-deps -e ../api` before the tests (they drive the real API in process). |
| apps-ui | `ui/` | `npm ci`, `npm run check:ci` (Biome lint and format; `npm run check` applies fixes), `npm run build`, `npm run size` (bundle budget, below), `npm run test:coverage` (the tests plus the coverage thresholds in `vite.config.ts`), `npm run test:e2e` (Playwright end-to-end and accessibility suite, below; `npm run test:a11y` runs only its accessibility tests) |
| Helm chart | `charts/nebari-apps/` | `helm lint charts/nebari-apps --set clusterDomain=nebari.example.com`, and `helm template` with `examples/nebari-values.yaml` (both validate against `values.schema.json`); the chart README must match `values.yaml` (regenerate below) |
| Docs | `docs/` | `bun install --frozen-lockfile`, `bun test test`, `bun run build` |
| Dependencies | `api/`, `mcp/`, `ui/` | `pip-audit` over the locked Python deps, `npm audit --audit-level=high` |
| Workflows | `.github/workflows/` | `actionlint` and `zizmor .github/workflows`. Pin every action to a full commit SHA with a `# vX.Y.Z` comment (Dependabot keeps them current), and give each workflow `permissions: contents: read`, widening per job only where needed. |

Runtime versions are pinned once and read everywhere: `ui/.node-version`, `api/.python-version`
and `mcp/.python-version` (CI's setup-node and uv read them), `docs/.bun-version`, and the
`toolchain` line in `operator/go.mod` (which `authz/go.mod` repeats). Base images are pinned
by digest. When you change a runtime version, change the pin file and the matching Dockerfile
`FROM` in the same PR; the Runtime pins check in CI fails when they disagree.

The UI has a bundle budget: `npm run size` gzips what the browser loads before first paint
(the entry script and everything `dist/index.html` preloads) and all JS, and fails when either
is over `bundleBudget` in `ui/package.json` (kB, gzip; 195 initial and 240 total today, about
5% above the current build). Pages load on first visit (`React.lazy` in `src/main.tsx`, which
also prefetches the other pages once the browser is idle) and keycloak-js only when auth is on, so new page code rarely touches the initial number. If it
goes over, move the code out of the initial load before raising the budget.

The UI's end-to-end suite (`ui/e2e/`, Playwright on Chromium) loads the production build
under `vite preview`, so run `npm run build` first. It mocks the apps-api with `page.route`
fixtures (`ui/e2e/fixtures.ts`, App data in `ui/e2e/data.ts`), so no cluster is needed. It
covers the apps list (the home page) with its Needs attention banner, Open links, and loading,
empty and error states (while a request is held open, the page's static chrome, such as the
heading, buttons, search, table headers and tabs, must already be real, with skeletons only where
the data goes), launching an app (validation included), an app's detail and logs, the Settings page, and
keyboard-only use of the launch form, the app actions and the account menu. `ui/e2e/motion.spec.ts`
checks the motion: a page eases in after a navigation but not on the first paint, rows that
replace a skeleton fade in, dialogs use the theme's duration token, and none of it runs under
`prefers-reduced-motion: reduce`. Tests tagged `@a11y` run axe over every page in light and dark and fail on a
`critical` or `serious` WCAG 2.0/2.1 A or AA violation; a second `mobile` project reruns them
at 390px wide alongside `ui/e2e/responsive.spec.ts`, which fails when a page or table scrolls
sideways or the header's nav runs under the account menu; unlike the jsdom check in
`ui/tests/pages/a11y.test.tsx`, they see real color contrast and focus order. One-time setup is
`npx playwright install chromium`; after a run, `npx playwright show-report` opens the HTML
report (CI uploads it as the `playwright-report` artifact).

The README screenshot (`docs/src/assets/screenshots/apps-list.png`) comes from the same
mocked API: after a UI change that alters the apps list, run `npm run build && npm run screenshot`
in `ui/` and commit the new image.

The operator's envtest suite runs the reconciler against a real kube-apiserver and etcd (no
kubelet), so it covers CRD validation, generations and watches that the fake client does not:

```sh
go install sigs.k8s.io/controller-runtime/tools/setup-envtest@release-0.25
cd operator && KUBEBUILDER_ASSETS=$(setup-envtest use -p path 1.37.0) go test -tags envtest ./internal/controller/ -run Envtest
```

Coverage floors sit a little under the current numbers. When a change adds tests, raise the floor
in the same PR rather than letting the margin grow.

Changing a chart value: document it with a `# --` comment in `charts/nebari-apps/values.yaml`,
add it to `values.schema.json` (unknown keys are rejected), and regenerate the chart README:

```sh
docker run --rm -v "$PWD:/helm-docs" -u "$(id -u)" jnorwood/helm-docs:v1.14.2 --chart-search-root charts
```

Install-time checks (`required`, `fail`) go in `templates/_validate.tpl`, and env shared by
apps-api and apps-mcp in `templates/_env.tpl`.

Regenerating the CRD after changing `operator/api/`:

```bash
cd operator
go install sigs.k8s.io/controller-tools/cmd/controller-gen@v0.21.0
controller-gen object paths="./api/..."
controller-gen crd paths="./api/..." output:crd:artifacts:config=../charts/nebari-apps/crds
cd .. && python3 .github/scripts/gen_crd_types.py   # ui/src/lib/crd.gen.ts
```

The UI's App types (`ui/src/lib/types.ts`) derive from the generated `crd.gen.ts`; apps-api's
Pydantic models stay hand-written, because they carry request rules the CRD cannot express, and
`api/tests/test_crd_conformance.py` holds their fields and bounds to the CRD.

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
