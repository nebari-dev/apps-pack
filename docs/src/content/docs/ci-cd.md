---
title: CI/CD & releasing
description: What CI checks on every pull request, how images and charts are built and signed, and how a release is cut.
---

## Checks on every pull request

| Workflow | Jobs | What fails it |
|---|---|---|
| **CI** (`ci.yaml`) | Operator | `go vet`, `go build`, golangci-lint, stale generated CRD/deepcopy code or UI types, an incompatible CRD change, `go test -race` and its `internal/` coverage floor, the envtest suite |
| | Python (api), Python (mcp) | `uv lock --check`, ruff, mypy (strict), pytest and its coverage floor, a known vulnerability in the locked set (`pip-audit`) |
| | UI | Biome, the production build, the bundle budget, vitest and its coverage thresholds, `npm audit --audit-level=high` |
| | UI e2e + a11y | Playwright on Chromium against the UI job's build (apps-api mocked): a user flow or keyboard path that breaks, or a `critical`/`serious` axe violation (WCAG 2.0/2.1 A and AA) on any page in light or dark, at desktop width and at 390px (where a page that scrolls sideways also fails); uploads the HTML report every run |
| | Helm chart | `helm lint`/`helm template` errors, `values.schema.json`, a stale chart README, chart RBAC assertions, the alert rules (promtool), kubeconform on the examples and rendered chart |
| | Repo invariants | a path in `AGENTS.md` or the skill that does not exist, version strings that disagree with the chart's `version`, a pin file that disagrees with its Dockerfile, actionlint, zizmor |
| **Images** (`images.yaml`) | one per image | the image does not build, or (`ui`) serves the wrong security headers; on changes to the images' sources only |
| **Docs** (`docs.yml`) | docs | the site's tests or build, or a broken external link (on docs changes only) |

CI also runs weekly, so advisories published after a merge surface even when nothing
changes: `pip-audit` and `npm audit`. Images are not scanned for vulnerabilities. The weekly run is also the only one that checks the vendored
nebari-ui skill against the registry, since the registry moving is not something a pull
request caused.

The checks that are scripts live in `.github/scripts/` and run locally from the repo root,
for example `python3 .github/scripts/check_versions.py`.

Every action is pinned to a commit SHA, and every workflow starts from
`permissions: contents: read`. Superseded runs on a pull request are cancelled.

## Images

`images.yaml` builds the five images (`operator`, `authz`, `api`, `ui`, `mcp`). Pull requests build each image once, on `linux/amd64`, without
pushing. Every merge to `main` builds them for `linux/amd64` and `linux/arm64` through the
org's reusable `pack-build-image` workflow, pushes `ghcr.io/nebari-dev/apps-pack/<image>`
and `quay.io/nebari/apps-pack-<image>`, tagged `sha-<short commit>` and `latest`, and signs
each image keyless with cosign, with a build-provenance attestation and an SBOM. The push
does not wait for the check job, so a failing check cannot block `latest` or a release's
images. `latest` tracks `main` for development only; released charts pin `sha-` tags.

To verify a signature, see
[Verifying Nebari pack artifacts](https://github.com/nebari-dev/.github/blob/main/verifying-nebari-artifacts.md).
The signer identity is the org workflow at the commit this repository pins
(`nebari-dev/.github/.github/workflows/pack-build-image.yaml@a6c757c72124a03542a79ac5385fd250ee9c45b7`).

## Cutting a release

Releases work as in the other Nebari packs: a pull request bumps the chart's version, and
merging it is the release.

1. **Merge pull requests with Conventional Commit titles.** They are squash-merged, so the
   title is the commit, and it decides the next version: `feat:` bumps the minor version
   while the pack is below 1.0, `fix:` the patch version (a breaking change, `!`, also bumps
   the minor version below 1.0).
2. **Open a release PR** titled `chore: release X.Y.Z`. Set every version string with
   `python3 .github/scripts/bump_version.py X.Y.Z` (the chart's `version` and `appVersion`,
   the API and MCP `__version__`, `ui/package.json` and its lockfile; CI fails if they
   disagree), and add the release's section to `CHANGELOG.md` from the feature, fix and
   breaking-change titles merged since the last release
   (`git log --oneline nebari-apps-<previous>..main`).
3. **Merging the release PR is the release.** The `Chart.yaml` version bump runs
   `release.yaml` (the org's `pack-release` workflow), which:
   - pins the chart's five image tags to `sha-<release commit>`, built by the same push,
   - packages and signs the chart and attaches it to a GitHub Release `nebari-apps-X.Y.Z`
     with generated notes,
   - opens a PR in [nebari-dev/helm-repository](https://github.com/nebari-dev/helm-repository)
     that publishes the chart to the org Helm repository once merged, and
   - mirrors the chart to `oci://ghcr.io/nebari-dev/apps-pack/charts`.

Install a release from either location:

```bash
helm install nebari-apps oci://ghcr.io/nebari-dev/apps-pack/charts/nebari-apps --version X.Y.Z ...
# or
helm repo add nebari https://raw.githubusercontent.com/nebari-dev/helm-repository/gh-pages/
helm install nebari-apps nebari/nebari-apps --version X.Y.Z ...
```

Then see [Upgrading](/upgrading/) for moving an existing install.

## Dependency updates

Dependabot opens grouped pull requests monthly for npm (`ui/`, `docs/`), uv (`api/`,
`mcp/`), Go modules, base images and GitHub Actions. Their titles are Conventional Commits
(`chore(deps): …`), so they stay out of the changelog's feature and fix sections.
