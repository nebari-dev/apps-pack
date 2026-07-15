---
title: Local development
---

The `dev/` directory provides a Makefile for local development with
[kind](https://kind.sigs.k8s.io/), mirroring the
[software-pack-template](https://github.com/nebari-dev/software-pack-template) dev flow. It
creates a kind cluster with the full Nebari infrastructure stack — MetalLB, Envoy Gateway,
cert-manager, Keycloak, and the nebari-operator (pinned to `v0.1.0-alpha.19`) — then builds
and deploys every pack component: the **apps-operator**, the **apps-api**, and the
**apps-ui**.

## Prerequisites

docker, kind, helm, kubectl, git.

## Quick start

```bash
cd dev

# Everything: kind cluster + Nebari stack + operator + api + ui + example app.
# The first run takes ~5-10 minutes; later runs reuse the cluster.
make up

open http://apps.nebari.local              # the UI
open http://docs-site.apps.nebari.local    # the example app
```

`make up` does, in order:

1. **`cluster`** — creates the kind cluster `nebari-apps-dev`, installs MetalLB, then uses
   the nebari-operator's dev scripts to install Envoy Gateway, cert-manager, Keycloak
   (realm `nebari`, login `admin` / `nebari-admin`), and the nebari-operator itself.
   Creates the `apps` namespace labeled `nebari.dev/managed=true`.
2. **`images`** — builds `apps-operator:dev`, `apps-api:dev`, and `apps-ui:dev` and loads
   them into the kind cluster.
3. **`deploy`** — installs the chart with `clusterDomain=nebari.local` and
   **`tls.enabled=false`** (plain HTTP — no certificate warnings locally).
4. Applies the inline example App and waits for `Running`.
5. Updates `/etc/hosts` with all NebariApp hostnames (prompts for sudo).

## Everyday loop

```bash
make redeploy       # rebuild all three images + restart the Deployments
make up-git         # also deploy the git-sourced, SSO-protected example
make update-hosts   # refresh /etc/hosts after launching apps
make port-forward   # host access on macOS/Docker Desktop (see below)
make down           # delete the kind cluster
```

## macOS / Docker Desktop

Docker Desktop does not route traffic to the kind network, so the gateway's LoadBalancer IP
is unreachable from the host. Two extra steps:

1. Map the hostnames to localhost in `/etc/hosts`:
   ```
   127.0.0.1 apps.nebari.local docs-site.apps.nebari.local
   ```
2. Run `make port-forward` (wraps sudo). It must listen on local port **80**: Envoy matches
   the exact `Host` header, and browsers append any non-default port (`host:8080` would
   404).

Then open `http://apps.nebari.local` — and type the `http://` scheme explicitly, because
browsers auto-upgrade bare hostnames to https, which is disabled locally.

## Auth in local dev

`make up` deploys with `api.auth.enabled=false`. The kind stack's Keycloak issuer is the
**in-cluster** service URL, which a host browser cannot reach, so keycloak-js logins (UI)
and JWT validation (API) cannot complete locally. Launched apps still get their
SecurityPolicies; on a real Nebari cluster with a public Keycloak everything works end to
end.

## Poking at the stack

```bash
curl http://apps.nebari.local/api/v1/apps               # the API, proxied by the UI
curl http://apps.nebari.local/api/v1/analytics/summary

kubectl get apps -n apps                                # the App CRs
kubectl describe app docs-site -n apps                  # conditions
kubectl logs -n nebari-apps deploy/nebari-apps-operator -f
```

## Troubleshooting

- **App stuck in `Deploying` with `RoutingReady: False`** — check
  `kubectl describe nebariapp app-<name> -n apps`.
- **`Failed` phase, message about namespace opt-in** — label the namespace:
  `kubectl label namespace <ns> nebari.dev/managed=true`.
- **Browser can't resolve `*.apps.nebari.local`** — run `make update-hosts` (or add the
  hostname to your `127.0.0.1` line on macOS).
- **Want to exercise the TLS path locally** — redeploy with `--set tls.enabled=true`; the
  local issuer is self-signed, so expect certificate warnings.
