---
title: Local development
---

The `dev/` directory provides a Makefile for local development with
[kind](https://kind.sigs.k8s.io/), mirroring the
[software-pack-template](https://github.com/nebari-dev/software-pack-template) dev flow. It
creates a kind cluster with the full Nebari infrastructure stack — Envoy Gateway,
cert-manager, Keycloak, and the nebari-operator (pinned to `%NEBARI_OPERATOR_VERSION%`) — then builds
and deploys every pack component: the **apps-operator**, the **apps-api**, the
**apps-ui**, and the **apps-mcp** server.

## Prerequisites

docker, kind, helm, kubectl, git.

## Quick start

```bash
cd dev

# Everything: kind cluster + Nebari stack + operator + api + ui + example app.
# The first run takes ~5-10 minutes; later runs reuse the cluster.
make up

open http://apps.nebari.test              # the UI
open http://docs-site.apps.nebari.test    # the example app
# MCP endpoint for coding agents: http://apps.nebari.test/mcp
```

`make up` does, in order:

1. **`check-dns`** — starts the local wildcard-DNS container and verifies
   `*.apps.nebari.test` resolves to `127.0.0.1`; on macOS, offers to install the one-time
   `/etc/resolver` file if it is missing (see below).
2. **`cluster`** — creates the kind cluster `nebari-apps-dev` (with host ports 80/443
   mapped into the node — see below), then uses the nebari-operator's dev scripts to
   install Envoy Gateway, cert-manager, Keycloak (realm `nebari`, login
   `admin` / `nebari-admin`), and the nebari-operator itself. Pins the gateway Service to
   fixed NodePorts and creates the `apps` namespace labeled `nebari.dev/managed=true`.
3. **`images`** — builds `apps-operator:dev`, `apps-api:dev`, `apps-ui:dev`, and
   `apps-mcp:dev` and loads them into the kind cluster.
4. **`deploy`** — installs the chart with `clusterDomain=nebari.test` and
   **`tls.enabled=false`** (plain HTTP — no certificate warnings locally).
5. Applies the inline example App and waits for `Running`.

## How host access works

No port-forwarding and no `/etc/hosts` edits — every app is reachable the moment its route
reconciles:

- **DNS** — a tiny CoreDNS container (`nebari-dev-dns`, started by `make up`) answers every
  `*.nebari.test` lookup with `127.0.0.1` on `127.0.0.1:53535`. A one-time
  `/etc/resolver/nebari.test` file (below) tells macOS to use it for that domain only —
  fully offline, no public DNS involved, and unaffected by routers that filter loopback
  answers. The container has `--restart unless-stopped`, so it survives reboots; `make
  down` leaves it running (remove it with `docker rm -f nebari-dev-dns`).
- **Routing** — `dev/kind-config.yaml` maps host ports 80/443 to fixed NodePorts
  (30080/30443) on the kind node, and an `EnvoyProxy` resource pins the gateway Service to
  those NodePorts. Traffic to `localhost:80` reaches Envoy directly — even on Docker
  Desktop, where the kind network is not routable from the host — and Envoy fans out to
  every app by `Host` header.

Type the `http://` scheme explicitly (browsers auto-upgrade bare hostnames to https, which
is disabled locally).

**The one-time resolver file** — the only sudo in the whole flow, once per machine.
`make up` offers to install it when run interactively, or do it yourself:

```bash
sudo sh -c 'mkdir -p /etc/resolver && printf "nameserver 127.0.0.1\nport 53535\n" > /etc/resolver/nebari.test'
```

(The domain is `nebari.test` rather than `nebari.local` because macOS routes `.local`
through mDNS/Bonjour, bypassing `/etc/resolver`; `.test` is the TLD reserved for this. On
Linux, route the domain to `127.0.0.1:53535` with a systemd-resolved drop-in —
`DNS=127.0.0.1:53535`, `Domains=~nebari.test` — or fall back to `/etc/hosts` entries.)

## Everyday loop

```bash
make redeploy       # rebuild all five images + restart the Deployments
make up-git         # also deploy the git-sourced, SSO-protected example
make down           # delete the kind cluster
```

## Auth in local dev

`make up` deploys with `api.auth.enabled=false`. The kind stack's Keycloak issuer is the
**in-cluster** service URL, which a host browser cannot reach, so keycloak-js logins (UI)
and JWT validation (API) cannot complete locally. Launched apps still get their
SecurityPolicies; on a real Nebari cluster with a public Keycloak everything works end to
end.

## Connecting a coding agent locally

The MCP server is proxied on the same hostname as the UI, so a local agent can drive the
whole stack:

```bash
claude mcp add --transport http nebari-apps http://apps.nebari.test/mcp
```

Because local dev runs with auth disabled, `/mcp` needs no sign-in and every tool works
anonymously — ask the agent to "launch the site in ./my-site as a
public app called my-site" and it will call `launch_app` directly. See the
[MCP server guide](/mcp/) for the full tool list.

## Poking at the stack

```bash
curl http://apps.nebari.test/api/v1/apps               # the API, proxied by the UI
curl http://apps.nebari.test/api/v1/analytics/summary

kubectl get apps -n apps                                # the App CRs
kubectl describe app docs-site -n apps                  # conditions
kubectl logs -n nebari-apps deploy/nebari-apps-operator -f
```

## Troubleshooting

- **App stuck in `Deploying` with `RoutingReady: False`** — check
  `kubectl describe nebariapp app-<name> -n apps`.
- **`Failed` phase, message about namespace opt-in** — label the namespace:
  `kubectl label namespace <ns> nebari.dev/managed=true`.
- **`make up` fails creating the kind cluster with a port-binding error** — something on
  the host already listens on port 80 or 443; stop it, or change the `hostPort` values in
  `dev/kind-config.yaml` (prefer freeing 80 — browsers append any non-default port to the
  `Host` header, which Envoy matches exactly).
- **Browser can't resolve `*.apps.nebari.test`** — run `make check-dns`: it restarts the
  DNS container if needed and installs the one-time `/etc/resolver/nebari.test` file on
  macOS. Verify the container directly with
  `dig @127.0.0.1 -p 53535 anything.apps.nebari.test`.
- **Cluster predates the NodePort setup** (URLs time out) — port mappings only apply at
  cluster creation; recreate with `make down && make up`.
- **"Gateway not yet programmed" warning during cluster setup** — expected: no LoadBalancer
  provider is installed; the gateway Service switches to NodePort in the step right after.
- **Want to exercise the TLS path locally** — redeploy with `--set tls.enabled=true`; the
  local issuer is self-signed, so expect certificate warnings.
