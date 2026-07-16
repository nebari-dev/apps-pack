# Nebari Apps Pack — Implementation Plan

Companion to [`DESIGN.md`](./DESIGN.md). Phased, each phase ends with a usable increment.

> **Status (2026-07-16):** Phases **0, 1, 3, 4, 5** are ✅ complete (each exit criterion
> verified end-to-end on the kind dev stack). Remaining: **Phase 6** (hardening beyond what
> shipped). Per-phase notes below record deviations.
>
> **Scope change (2026-07-16):** Python app support (frameworks, `image`/`ociEnv` sources,
> Nebi pixi environments — the old Phase 2) has been **removed from this pack**. It
> overlapped with [python-capability-pack](https://github.com/nebari-dev/python-capability-pack),
> which owns pixi-backed Python services. This pack now focuses on **static web apps**
> (`inline`/`git`/`pvc` sources served by nginx). The `framework` field and
> `runtime.command` were dropped from the `App` CRD and all client surfaces.

## Guiding principles
- **The `App` CR is the contract.** Build it first; everything else produces or reconciles it.
- **Vertical slices.** Each phase delivers a thing you can demo, not a horizontal layer.
- **API is the single authority.** UI and MCP are thin clients over apps-api from the start.

---

## Phase 0 — Foundations & scaffolding ✅ Complete
**Goal:** repo + CRD + a static app reconciles to a running pod behind Nebari SSO.
- Scaffold `nebari-apps-pack/` per DESIGN §15; `pack-metadata.yaml`, Helm chart skeleton.
- Define the **`App` CRD** (`apps.nebari.dev/v1alpha1`) — types in Go (kubebuilder) + generated CRD YAML.
- **apps-operator** MVP: reconcile `source.type: inline|git` →
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
- `POST/GET/PATCH/DELETE /apps`, `:stop`/`:start`, `/capabilities`.
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

## ~~Phase 2 — Python apps + Nebi env delivery~~ ❌ Removed from scope
> **Removed 2026-07-16.** Python frameworks, prebuilt-image sources, and Nebi/`ociEnv`
> pixi environments were cut in favor of
> [python-capability-pack](https://github.com/nebari-dev/python-capability-pack), which
> already implements the pixi runtime model for Python services. The Python-via-image
> support that had been pulled forward (framework table, `image` source, TCP probes,
> framework env injection) was removed from the operator, API, UI, MCP, and skill.

## Phase 3 — apps-ui ✅ Complete
**Goal:** the jhub-apps-style form launcher, JupyterHub-free.
- React + Vite + shadcn/ui; Keycloak SSO; TanStack Query + Jotai.
- Catalog/dashboard, **launch form** (source tabs, resources, env vars,
  access), app detail with **status + logs viewer + events + metrics**, edit/stop/start/delete.
- Expose as `NebariApp` (landing-page tile "Apps").
- **Exit:** a user launches + manages an app end-to-end from the browser.

> **Done.** Deviations: built on the official **nebari-design** system (shadcn-compatible
> registry) instead of stock shadcn/ui, following the chat-pack react baseline; keycloak-js
> SPA PKCE with runtime config (auth works with one image on or off); TanStack Query without
> Jotai (no client state warranted it yet). Includes a dashboard with analytics
> (status/source/namespace breakdowns, replica readiness) and **zip/.html upload** in the
> launch form. Detail view ships status + conditions + logs + events; pod metrics and a
> pre-populated edit form are still open. The UI lives at `apps.<cluster-domain>` itself.

## Phase 4 — apps-mcp ✅ Complete
**Goal:** natural-language launch/manage from a coding agent.
- FastMCP server (streamable HTTP) exposed as a `NebariApp`.
- **Keycloak device flow** auth (`authenticate` tool; token cache/refresh).
- Tools: `launch_app`, `list_apps`, `get_app`, `get_app_status`, `get_app_logs`,
  `update_app`, `stop_app`/`start_app`, `remove_app`, `describe_cluster` — all thin
  wrappers over apps-api.
- LLM-oriented tool descriptions; `launch_app` idempotent on `(namespace, name)`.
- **Exit:** from Claude Code/Codex: "launch this site" → running app.

> **Done.** Deviations: no separate `NebariApp`/hostname — the MCP is
> served at **`apps.<cluster-domain>/mcp`** through the UI's nginx, and the UI's NebariApp
> provisions the device-flow client alongside the SPA client. Beyond plan: middleware
> **verifies JWTs at the MCP layer** (all tools except `authenticate`) before apps-api
> verifies them again; device-flow tokens are cached per MCP session; bearer passthrough
> supported. (`list_frameworks`/`list_environments` were removed with the Python scope cut,
> leaving 11 tools.)

## Phase 5 — the scaffolding skill ✅ Complete
**Goal:** agents generate apps in the exact expected layout.
- Skill (`/new-nebari-app`): scaffold a static starter and a
  **`nebari-app.yaml`** manifest (1:1 with `App.spec`).
- Emits the NL launch instruction for the MCP; reads `nebari-app.yaml` on launch.
- **Exit:** agent generates an app, user says "launch it," MCP reads the manifest and deploys.

> **Done** (`skill/new-nebari-app/`: SKILL.md + manifest reference + static starter
> template). Deviations: the **agent** reads `nebari-app.yaml` and maps it
> onto `launch_app` (the in-cluster MCP has no filesystem access) — the mapping table lives
> in the skill's reference. Exit verified:
> scaffold → "launch it" → Running → serving, via the live MCP. (The Streamlit/FastAPI
> starters were removed with the Python scope cut.)

## Phase 6 — Observability, security, hardening ⏳ Partially complete
- Pod hardening (non-root, RO FS, seccomp, limits), default-deny NetworkPolicies.
- Metrics (ServiceMonitor for operator + apps), events aggregation, audit surfacing.
- Public-app confirmation guardrails; secret handling via Secret refs.
- Docs: README, install guide, examples (sample `App` CRs + ArgoCD Application).
- **Exit:** install via Helm/ArgoCD on a clean cluster following the docs; security review passes.

> **Shipped along the way:** pod hardening (non-root, dropped capabilities, seccomp
> `RuntimeDefault`, injection-safe git init containers, size/type-capped uploads), events
> aggregation in API/UI, docs site (Astro Starlight, 9 pages) + README + examples, CI
> (lint/test/build-image for all four components). **Remaining:** default-deny
> NetworkPolicies, ServiceMonitor/metrics, audit surfacing, resource
> limit defaults on app pods, public-app confirmation guardrails in the UI, an ArgoCD
> Application example, and a security review.

---

## Cross-cutting workstreams
- **CI/CD:** image builds for operator/api/ui/mcp; chart lint; e2e against k3d (mirror other packs).
  *Status: image builds (GHCR, 4 images), chart/CRD/example lint, and per-component test
  workflows are in; a CI e2e job against kind is still to add (the flow runs manually today).*
- **Versioning/release:** semver tags + chart publish to `oci://quay.io/nebari/charts` (pack convention).
  *Status: not started.*
- **Testing:** operator envtest + reconcile unit tests; api pytest; ui vitest; e2e for the
  static-app flow.
  *Status: operator fake-client reconcile + NebariApp contract tests; api pytest; mcp
  pytest against the real API in-process; docs build tests; ui has type-checked builds
  but no vitest suite yet.*

## Sequencing notes
- Phases 0→1 were the critical path; 3 (UI), 4 (MCP), and 5 (skill) built directly on them.
- Phase 5 (skill) depends on the `nebari-app.yaml` schema being frozen (end of Phase 1). ✅
- Defer scale-to-zero unless prioritized.

## Risks
- **nebari-operator `NebariApp` contract drift** — pin the version; add a contract test.
  ✅ *Mitigated: pinned to `v0.1.0-alpha.19`, contract tests in the operator suite.*
- **Untrusted agent-generated content** — tenancy + hardening must land before any public
  exposure. ⏳ *Pod hardening + namespace tenancy shipped; NetworkPolicies remain (Phase 6).*
- **Keycloak device-flow client provisioning** — confirm nebari-operator exposes this for the MCP.
  ✅ *Confirmed and in use: `auth.deviceFlowClient` on the UI's NebariApp provisions it.*
