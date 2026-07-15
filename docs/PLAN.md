# Nebari Apps Pack — Implementation Plan

Companion to [`DESIGN.md`](./DESIGN.md). Phased, each phase ends with a usable increment.

> **Status (2026-07-15):** Phases **0, 1, 3, 4, 5** are ✅ complete (each exit criterion
> verified end-to-end on the kind dev stack), plus Python-apps-from-prebuilt-images pulled
> forward from Phase 2. Remaining: **Phase 2** (Nebi/`ociEnv` pixi environments) and
> **Phase 6** (hardening beyond what shipped). Per-phase notes below record deviations.

## Guiding principles
- **The `App` CR is the contract.** Build it first; everything else produces or reconciles it.
- **Vertical slices.** Each phase delivers a thing you can demo, not a horizontal layer.
- **API is the single authority.** UI and MCP are thin clients over apps-api from the start.
- **Soft-depend on Nebi.** Static-app path must work before any pixi/Nebi integration lands.

---

## Phase 0 — Foundations & scaffolding ✅ Complete
**Goal:** repo + CRD + a static app reconciles to a running pod behind Nebari SSO.
- Scaffold `nebari-apps-pack/` per DESIGN §15; `pack-metadata.yaml`, Helm chart skeleton.
- Define the **`App` CRD** (`apps.nebari.dev/v1alpha1`) — types in Go (kubebuilder) + generated CRD YAML.
- **apps-operator** MVP: reconcile `framework: static`, `source.type: inline|git` →
  Deployment(nginx) + Service + **`NebariApp`** (routing/auth/landing) + status.
- Local dev loop (k3d/minikube + Tilt; mirror `k8s-deploy` conventions).
- **Exit:** `kubectl apply` a static `App` → reach it at `https://<sub>.<cluster>` behind Keycloak.

> **Done.** `pvc` sources landed too. Deviations: local dev is **kind + Makefile**
> (mirroring software-pack-template, the adopted source of truth) rather than k3d/Tilt;
> app URLs are `<sub>.apps.<cluster-domain>` (dedicated apps zone); TLS is chart-toggleable
> (`tls.enabled`, off in local dev). NebariApp contract pinned to nebari-operator
> `v0.1.0-alpha.19` with a contract test.

## Phase 1 — apps-api + CRUD ✅ Complete
**Goal:** create/manage apps over HTTP; CR is written by the API, not by hand.
- FastAPI service: OIDC bearer auth (Keycloak, split-horizon issuer), RBAC by group/namespace.
- `POST/GET/PATCH/DELETE /apps`, `:stop`/`:start`, `/frameworks`, `/capabilities`.
- App CR rendering + apply via k8s client; DB (async SQLAlchemy) for metadata cache + audit.
- Status read-back from CR; `/apps/{id}/status`.
- Expose apps-api as a `NebariApp`.
- **Exit:** launch + delete a static app entirely through the REST API.

> **Done**, and beyond: `/logs`, `/events`, `/analytics/summary`, and multipart
> **zip/.html upload** (`POST /apps/upload` → inline source). Deviations: **no DB** — the
> API is stateless and the CR remains the sole source of truth (a cache/audit DB can come
> later if listing scale demands it); authorization = valid Keycloak JWT + managed-namespace
> checks (finer group-based RBAC deferred); the API is not its own `NebariApp` — it is
> served same-origin at `/api` through the UI's nginx.

## Phase 2 — Python apps + Nebi env delivery ⏳ Partially complete
**Goal:** Python frameworks run in pixi envs from Nebi OCI artifacts.
- Operator: `framework: streamlit|panel|gradio|dash|voila|fastapi|custom`; framework→command table.
- **Environment reconciler:** `source.type: ociEnv` → init container pulls Nebi-published pixi
  env into shared volume; main container runs framework command inside it; `EnvironmentReady`.
- Base runtime image (python + pixi shim).
- apps-api `GET /environments` (proxy/cache Nebi `GET /workspaces`); `/capabilities` reports `nebi`.
- **Inline-pixi fallback** (Nebi absent): solve an inline `pixi.toml` in an init container.
- **Exit:** launch a Streamlit app using a Nebi env via the API; and a Python app with no Nebi.

> **Pulled forward:** the framework table and all Python frameworks via
> `source.type: image` (prebuilt images, framework env injection, TCP probes) — a Python
> app launches through API/UI/MCP today. **Remaining:** everything Nebi — `ociEnv` env
> reconciler + init container, base runtime image, `GET /environments` proxy (currently a
> stub), `/capabilities` nebi flag, and the inline-pixi fallback. The CRD, API models, and
> skill manifests already carry the `ociEnv` fields.

## Phase 3 — apps-ui ✅ Complete
**Goal:** the jhub-apps-style form launcher, JupyterHub-free.
- React + Vite + shadcn/ui; Keycloak SSO; TanStack Query + Jotai.
- Catalog/dashboard, **launch form** (framework, source tabs, env dropdown, resources, env vars,
  access), app detail with **status + logs viewer + events + metrics**, edit/stop/start/delete.
- Expose as `NebariApp` (landing-page tile "Apps").
- **Exit:** a user launches + manages an app end-to-end from the browser.

> **Done.** Deviations: built on the official **nebari-design** system (shadcn-compatible
> registry) instead of stock shadcn/ui, following the chat-pack react baseline; keycloak-js
> SPA PKCE with runtime config (auth works with one image on or off); TanStack Query without
> Jotai (no client state warranted it yet). Includes a dashboard with analytics
> (status/framework/namespace breakdowns, replica readiness) and **zip/.html upload** in the
> launch form. Detail view ships status + conditions + logs + events; pod metrics and a
> pre-populated edit form are still open. The UI lives at `apps.<cluster-domain>` itself.

## Phase 4 — apps-mcp ✅ Complete
**Goal:** natural-language launch/manage from a coding agent.
- FastMCP server (streamable HTTP) exposed as a `NebariApp`.
- **Keycloak device flow** auth (`authenticate` tool; token cache/refresh).
- Tools: `list_environments`, `list_frameworks`, `launch_app`, `list_apps`, `get_app`,
  `get_app_status`, `get_app_logs`, `update_app`, `stop_app`/`start_app`, `remove_app`,
  `describe_cluster` — all thin wrappers over apps-api.
- LLM-oriented tool descriptions; `launch_app` idempotent on `(namespace, name)`.
- **Exit:** from Claude Code/Codex: "launch this Streamlit app with the ds-stack env" → running app.

> **Done** (exit verified with an image-sourced app; the "ds-stack env" variant waits on
> Phase 2). All 13 tools shipped. Deviations: no separate `NebariApp`/hostname — the MCP is
> served at **`apps.<cluster-domain>/mcp`** through the UI's nginx, and the UI's NebariApp
> provisions the device-flow client alongside the SPA client. Beyond plan: middleware
> **verifies JWTs at the MCP layer** (all tools except `authenticate`) before apps-api
> verifies them again; device-flow tokens are cached per MCP session; bearer passthrough
> supported.

## Phase 5 — the scaffolding skill ✅ Complete
**Goal:** agents generate apps in the exact expected layout.
- Skill (`/new-nebari-app`): scaffold static + Python starters, `pixi.toml`, and a
  **`nebari-app.yaml`** manifest (1:1 with `App.spec`).
- Emits the NL launch instruction for the MCP; reads `nebari-app.yaml` on launch.
- **Exit:** agent generates an app, user says "launch it," MCP reads the manifest and deploys.

> **Done** (`skill/new-nebari-app/`: SKILL.md + manifest reference + starter templates for
> static/Streamlit/FastAPI). Deviations: the **agent** reads `nebari-app.yaml` and maps it
> onto `launch_app` (the in-cluster MCP has no filesystem access) — the mapping table lives
> in the skill's reference; Python starters ship a Dockerfile alongside `pixi.toml` so they
> deploy today via `image` source, switching to `ociEnv` when Phase 2 lands. Exit verified:
> scaffold → "launch it" → Running → serving, via the live MCP.

## Phase 6 — Observability, security, hardening ⏳ Partially complete
- Pod hardening (non-root, RO FS, seccomp, limits), default-deny NetworkPolicies, registry allowlist.
- Metrics (ServiceMonitor for operator + apps), events aggregation, audit surfacing.
- Public-app confirmation guardrails; secret handling via Secret refs.
- Docs: README, install guide, examples (sample `App` CRs + ArgoCD Application).
- **Exit:** install via Helm/ArgoCD on a clean cluster following the docs; security review passes.

> **Shipped along the way:** pod hardening (non-root, dropped capabilities, seccomp
> `RuntimeDefault`, injection-safe git init containers, size/type-capped uploads), events
> aggregation in API/UI, docs site (Astro Starlight, 9 pages) + README + examples, CI
> (lint/test/build-image for all four components). **Remaining:** default-deny
> NetworkPolicies, registry allowlist, ServiceMonitor/metrics, audit surfacing, resource
> limit defaults on app pods, public-app confirmation guardrails in the UI, an ArgoCD
> Application example, and a security review.

---

## Cross-cutting workstreams
- **CI/CD:** image builds for operator/api/ui/mcp; chart lint; e2e against k3d (mirror other packs).
  *Status: image builds (GHCR, 4 images), chart/CRD/example lint, and per-component test
  workflows are in; a CI e2e job against kind is still to add (the flow runs manually today).*
- **Versioning/release:** semver tags + chart publish to `oci://quay.io/nebari/charts` (pack convention).
  *Status: not started.*
- **Testing:** operator envtest + reconcile unit tests; api pytest; ui vitest; one e2e per framework.
  *Status: operator fake-client reconcile + NebariApp contract tests; api pytest (16); mcp
  pytest against the real API in-process (14); docs build tests; ui has type-checked builds
  but no vitest suite yet.*

## Sequencing notes
- ~~Phases 0→1→2 are the critical path~~ 3 (UI), 4 (MCP), and 5 (skill) shipped **ahead of**
  Phase 2 by pulling Python-via-image forward — Nebi/`ociEnv` now slots in without changing
  any client surface (the CRD, API models, and skill manifests already carry the fields).
- Phase 5 (skill) depends on the `nebari-app.yaml` schema being frozen (end of Phase 1). ✅
- Defer scale-to-zero and the image-build pipeline (DESIGN §16) unless prioritized.

## Risks
- **nebari-operator `NebariApp` contract drift** — pin the version; add a contract test.
  ✅ *Mitigated: pinned to `v0.1.0-alpha.19`, contract tests in the operator suite.*
- **Untrusted agent-generated code** — tenancy + hardening must land before any public exposure.
  ⏳ *Pod hardening + namespace tenancy shipped; NetworkPolicies and registry allowlist remain
  (Phase 6).*
- **Nebi OCI env format** — confirm the artifact layout Nebi publishes and how pixi materializes it
  in an init container (validate early in Phase 2; it's the biggest unknown). ⏳ *Still open.*
- **Keycloak device-flow client provisioning** — confirm nebari-operator exposes this for the MCP.
  ✅ *Confirmed and in use: `auth.deviceFlowClient` on the UI's NebariApp provisions it.*
