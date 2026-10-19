---
title: CI/CD & releasing
description: What CI checks on every pull request, how images and charts are built and signed, and how a release is cut.
---

## Checks on every pull request

| Workflow | Jobs | What fails it |
|---|---|---|
| **Lint** (`lint.yaml`) | Helm chart, Operator, Python lint (api, mcp), UI lint, Runtime pins, Version strings, Agent docs | `helm lint`/`helm template` errors, chart RBAC assertions, kubeconform on the examples and rendered chart, `go vet`, golangci-lint, stale generated CRD code, ruff, mypy (strict), Biome, a pin file that disagrees with its Dockerfile, version strings that disagree with the release manifest, a path in `AGENTS.md` or the skill that does not exist |
| **Test** (`test.yaml`) | Operator unit tests, API tests, MCP tests, UI build | `go test -race`, pytest (with `uv lock --check`), vitest and the production build |
| **Audit** (`audit.yaml`) | Python deps, UI deps, vendored nebari-ui skill | a known vulnerability in a locked dependency (`pip-audit`, `npm audit --audit-level=high`); also runs weekly |
| **Build Images** (`build-image.yaml`) | build per image, Trivy scan per image | the image does not build, or has a HIGH/CRITICAL vulnerability with a fix available |
| **Workflow lint** (`workflow-lint.yaml`) | actionlint, zizmor | workflow syntax or a security finding (on workflow changes only) |
| **Docs** (`docs.yml`) | docs | the site's tests or build, or a broken external link (on docs changes only) |

Every action is pinned to a commit SHA, and every workflow starts from
`permissions: contents: read`. Superseded runs on a pull request are cancelled.

## Images

`build-image.yaml` builds the four images (`apps-operator`, `apps-api`, `apps-ui`,
`apps-mcp`) for `linux/amd64` and `linux/arm64` through the org's reusable
`pack-build-image` workflow. Pull requests build without pushing. Every merge to `main`
pushes `ghcr.io/nebari-dev/apps-pack/<image>` and `quay.io/nebari/apps-pack-<image>`, tagged
`sha-<short commit>` and `latest`, and signs each image keyless with cosign, with a
build-provenance attestation and an SBOM. `latest` tracks `main` for development only;
released charts pin `sha-` tags.

To verify a signature, see
[Verifying Nebari pack artifacts](https://github.com/nebari-dev/.github/blob/main/verifying-nebari-artifacts.md).

## Cutting a release

1. **Merge pull requests with Conventional Commit titles.** They are squash-merged, so the
   title is the commit, and it decides the next version: `feat:` bumps the minor version
   while the pack is below 1.0, `fix:` the patch version.
2. **release-please keeps a release PR open** (`release-please.yaml`), titled
   `chore: release X.Y.Z`. It bumps every version string together (the chart's `version`
   and `appVersion`, the API and MCP `__version__`, `ui/package.json` and its lockfile) and
   adds the release's section to `CHANGELOG.md`. Without a `RELEASE_PLEASE_TOKEN` secret the
   PR is opened with `GITHUB_TOKEN`, which does not start CI; close and reopen it to run the
   checks.
3. **Merging the release PR is the release.** The `Chart.yaml` version bump runs
   `release.yaml` (the org's `pack-release` workflow), which:
   - pins the chart's four image tags to `sha-<release commit>`, built by the same push,
   - packages and signs the chart and attaches it to a GitHub Release `nebari-apps-X.Y.Z`
     with generated notes,
   - opens a PR in [nebari-dev/helm-repository](https://github.com/nebari-dev/helm-repository)
     that publishes the chart to the org Helm repository once merged, and
   - mirrors the chart to `oci://ghcr.io/nebari-dev/apps-pack/charts`.
4. **Project board.** Merging a PR moves its linked issues to *Merged*; each release moves
   every *Merged* issue to *Released* (`project-status.yaml`).

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
