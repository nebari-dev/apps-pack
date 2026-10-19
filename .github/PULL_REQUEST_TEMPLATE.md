<!--
Title: a Conventional Commit subject, e.g. `fix(api): reject empty subdomains`.
PRs are squash-merged, so the title becomes the commit on main. See CONTRIBUTING.md.
-->

Closes #

## What changes

<!-- What this does and why. Call out anything a reviewer should look at closely. -->

## Upgrade notes

<!-- Anything an operator must do when upgrading (new RBAC, values, CRD changes), or "None". -->

## Testing

<!-- What you ran, and how you checked it on a cluster if the change touches the operator, chart or auth. -->

## Checklist

- [ ] The title is a Conventional Commit subject
- [ ] The `Closes #` line names the issue this resolves
- [ ] The quality gates for every component I touched pass locally ([CONTRIBUTING.md](https://github.com/nebari-dev/apps-pack/blob/main/CONTRIBUTING.md#quality-gates))
- [ ] New or changed behavior has tests
- [ ] The CRD and deepcopy code are regenerated, if `operator/api/` changed
- [ ] Docs (`docs/`, `README.md`, `skill/`) describe the new behavior
