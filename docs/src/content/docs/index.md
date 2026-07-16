---
title: Nebari Apps Pack
---

The Nebari Apps Pack lets users launch, manage, and observe **static web apps**
(HTML/CSS/JS, served by nginx) on a [Nebari](https://nebari.dev) Kubernetes cluster —
behind Keycloak SSO, with no Kubernetes knowledge required. Python services are handled
by the separate [python-capability-pack](https://github.com/nebari-dev/python-capability-pack).

Everything converges on one declarative resource: the **`App`** custom resource
(`apps.nebari.dev/v1alpha1`). Whether an app is launched from the web UI, the REST API, or
`kubectl apply`, the **apps-operator** reconciles the same contract into a Deployment, a
Service, and a `NebariApp` — and the [nebari-operator](https://github.com/nebari-dev/nebari-operator)
turns that into routing, TLS, authentication, and a landing-page tile.

Each app gets its own URL under the cluster's apps domain:

```
https://<subdomain>.apps.<cluster-domain>
```

## What ships today

- **apps-operator** — reconciles `App` resources. Static apps from inline files, a git
  repository, or a PVC.
- **apps-api** — REST API for CRUD, status, logs, events, analytics, and direct
  **zip/.html upload**.
- **apps-ui** — a dashboard built on the [Nebari design system](https://github.com/nebari-dev/nebari-design):
  analytics, an apps table, per-app detail pages with live logs and events, and a launch
  form with drag-and-drop upload.
- **apps-mcp** — an MCP server at `/mcp` so coding agents launch and manage apps with
  natural language (Keycloak device-flow auth).
- **`new-nebari-app` skill** — teaches Claude Code to scaffold apps in the expected layout
  with a `nebari-app.yaml` manifest, so "generate, then launch it" is one flow.

## In this guide

- **[Getting started](/getting-started/)** — install the chart on a Nebari cluster and launch
  your first app
- **[Launching apps](/launching-apps/)** — every way to launch: UI, upload, API, and plain CRs
- **[MCP server](/mcp/)** — connect a coding agent and launch apps with natural language
- **[Scaffolding skill](/skill/)** — generate launch-ready apps with Claude Code
- **[Local development](/local-development/)** — run the whole stack on your laptop with kind

## Reference pages

- **[App CRD reference](/app-crd-reference/)** — complete field-by-field reference for the
  `App` custom resource
- **[REST API](/api-reference/)** — the apps-api endpoints
- **[Architecture & auth](/architecture/)** — how the pieces fit together and how
  authentication works

## Looking for Python apps?

Python app support was removed from this pack in favor of
[python-capability-pack](https://github.com/nebari-dev/python-capability-pack), which owns
Python services. See
[`docs/PLAN.md`](https://github.com/nebari-dev/nebari-apps-pack/blob/main/docs/PLAN.md) in the
repository for the full roadmap.
