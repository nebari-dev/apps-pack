---
title: MCP server
---

The **apps-mcp** server lets coding agents (Claude Code, Codex, or any MCP client) launch
and manage apps with natural language. It is a thin, well-described layer of tools,
[resources](#resources) and [prompts](#prompts) over the [REST API](/api-reference/) — no
business logic of its own, so agent launches behave exactly like UI launches.

**Endpoint:** `https://apps.<cluster-domain>/mcp` (streamable HTTP — the UI's nginx proxies
`/mcp` to the MCP service, so the whole platform lives on one hostname).

## Connecting

The UI's **Settings** page (account menu → **Settings**, under **Connect an agent**) shows
your cluster's MCP URL and this command with copy buttons.

```bash
# Claude Code
claude mcp add --transport http nebari-apps https://apps.example.ai/mcp
```

Or in any MCP client configuration:

```json
{
  "mcpServers": {
    "nebari-apps": { "type": "http", "url": "https://apps.example.ai/mcp" }
  }
}
```

## Authentication

Two ways to present an identity:

1. **Device flow (interactive)** — call the `authenticate` tool. It returns a Keycloak
   verification URL and user code; the user approves in a browser, the agent calls
   `authenticate` again, and the token is cached (and refreshed) **per MCP session**. The
   public device-flow client is provisioned automatically by the pack's `NebariApp`
   (`auth.deviceFlowClient`).
2. **Bearer passthrough** — clients that already hold a token send a standard
   `Authorization: Bearer <token>` header.

Enforcement is layered:

- **At the MCP layer** — middleware verifies the token's signature, issuer, and expiry
  against the realm JWKS before *any* tool or resource logic runs. Every tool except
  `authenticate` (the login bootstrap), and every resource read, is rejected for anonymous or
  forged callers with an error telling the agent to call `authenticate`. Listing resources
  still answers, without any Apps. Prompts carry no cluster data and need no login.
- **At the API layer** — apps-api independently validates the JWT on every request, so the
  MCP can never act with more privilege than the calling user: an agent sees and manages
  only the apps its user owns or [manages](/launching-apps/#managers) (or every app, for
  members of an admin group). Resources make the same API calls as the matching tools, so
  they are authorized the same way.

On clusters with auth disabled, `authenticate` reports `not_required` and every tool works
anonymously.

The device flow calls Keycloak at its browser-facing URL (`keycloak.url`) from inside the
cluster. If that certificate comes from a private CA, `authenticate` fails with
`CERTIFICATE_VERIFY_FAILED` until the CA is trusted through
[`mcp.orgCABundle`](/configuration/#apps-mcp).

## Tools

| Tool | Purpose |
|---|---|
| `authenticate` | Start/complete the device-flow login, or confirm the cached token. |
| `describe_cluster` | Source types, launchable namespaces, apps domain, the cluster's default idle timeout and, when `image` is a source type, the `imageRegistries` images may come from — call first to pick valid options. |
| `launch_app` | Create + launch (static, Python/pixi via `pixi_task`, or a prebuilt container image with `source_type: image`, `image_reference` (tag or digest, from an allowed registry) and `image_port`, plus optional `image_command`, `image_args` and `image_run_as_user`; see [Container images](/launching-apps/#container-images)); optional `resources` (requests/limits, cluster defaults otherwise) and `groups`/`users` to restrict a private app (a member of any group or a listed user gets in; everyone else gets `403`); `idle_timeout_minutes` and `keep_alive` control [scale to zero](/app-crd-reference/#scale-to-zero); `manager_users`/`manager_groups` set who else may [manage](/launching-apps/#managers) it (omit to keep the current list); `secrets` (`{NAME: value}`) stores credentials in the app's own Secret instead of `env` (see [Secrets](#secrets)). **Idempotent on (namespace, name)** — re-launching an app you own or manage updates it instead of failing, so retries are safe; any other app is refused, never overwritten. Only the owner or an admin may change the managers. |
| `list_apps` | Apps with phase, URL, owner; optional namespace filter. Inline sources list file `paths` only. |
| `get_app` | Full spec + status for one app; inline files come back fenced (see below). |
| `get_app_status` | Lightweight poll: phase, URL, replicas, conditions. |
| `get_app_logs` | Recent pod logs (fenced, last 64 KiB) — first stop when phase is `Failed`. |
| `update_app` | Patch spec (source, runtime, access, …). `access.managers` (`{users, groups}`) is the manager list; only the owner or an admin may change it. `secrets` (`{NAME: value}` sets or rotates, `{NAME: null}` removes) changes the app's secret values. |
| `stop_app` / `start_app` | Scale to zero / back up; `start_app` also wakes an `Idle` app. |
| `restart_app` | Roll the app's pods without changing the spec; fails if the app is stopped. |
| `get_app_metrics` | Per pod: instantaneous CPU/memory usage (`available:false`, and no usage, when the cluster has no metrics server), plus the app container's restarts, last termination (`reason` such as `OOMKilled`, `exitCode`, `finishedAt`), `startedAt`, and CPU/memory `limits` and `requests`, which come from the pod either way. |
| `remove_app` | Delete permanently (cascades). Refused unless called with `confirm: true`, which the agent sets only after the user agrees. |

Every tool carries MCP annotations, so clients that auto-approve tools can tell them
apart: `describe_cluster`, `list_apps`, `get_app`, `get_app_status`, `get_app_logs` and
`get_app_metrics` are `readOnlyHint`; `launch_app` (it updates an existing app),
`update_app`, `stop_app` and `remove_app` are `destructiveHint`.

## Resources

Clients that support [MCP resources](https://modelcontextprotocol.io/docs/concepts/resources)
can attach an app's spec, status, logs or events as context without calling a tool. URIs use
the server's own scheme, `nebari-apps://`, so they cannot collide with another server's, and
their paths mirror the REST API (`/api/v1/apps/{namespace}/{name}/…`):

| URI | Content (JSON) | Same as |
|---|---|---|
| `nebari-apps://cluster` | What the cluster supports: source types, namespaces, apps domain, idle timeout, image registries. | `describe_cluster` |
| `nebari-apps://apps` | The apps you own or manage (all apps for admins); inline sources list file `paths` only. | `list_apps` |
| `nebari-apps://apps/{namespace}/{name}` | One app's full spec and status, with your `role`; inline files fenced. | `get_app` |
| `nebari-apps://apps/{namespace}/{name}/status` | Phase, URL, replicas, conditions, message. | `get_app_status` |
| `nebari-apps://apps/{namespace}/{name}/logs{?lines,container}` | Recent pod logs, fenced (last 64 KiB). `lines` is 1–5000 (default 200); `container` defaults to `app`, and `git-clone`, `copy-source` or `authz` read the init containers or the sidecar, e.g. `…/logs?lines=500&container=git-clone`. | `get_app_logs` |
| `nebari-apps://apps/{namespace}/{name}/events` | Kubernetes events for the app and its workload, newest first, fenced as one JSON document (capped at 32 KiB). | — |

`resources/list` returns the two fixed resources plus one `nebari-apps://apps/{namespace}/{name}`
entry per app you own or manage, fetched for each request with your token; the other three
are resource templates. An entry's description carries only its phase and your role, never
text the app's author wrote. Secret values never appear in any resource: like the tools, they
show only the names in `runtime.secretKeys`. A read you are not authorized for fails with the
API's `403` or `404`. Subscriptions (change notifications) are not supported yet; re-read
`…/status` to poll.

## Prompts

[Prompts](https://modelcontextprotocol.io/docs/concepts/prompts) package the common workflows.
Each returns one message that tells the agent which resources to read, in order (with the
matching tool for clients without resource support), instead of inlining logs or specs:

| Prompt | Arguments | What it does |
|---|---|---|
| `triage_app` | `namespace`, `name` | Diagnose a failing or stuck app in the order [Troubleshooting](/troubleshooting/) uses: status, the first `False` condition, events, then logs (including the init containers), then propose a fix and wait for the user before changing anything. |
| `launch_from_manifest` | `path` (default `nebari-app.yaml`) | Launch or update an app from a [`nebari-app.yaml`](/skill/) manifest: map it onto `launch_app`, check it against `nebari-apps://cluster`, keep secret values out of `env`, poll the status resource until `Running`. |
| `review_access` | `namespace`, `name` | Summarize who can open the app (public, signed-in users, or restricted to `groups`/`users`) and who can manage it (owner, `access.managers`, admins), your role, landing-page and `env` exposure, and propose an `update_app` patch for the user to approve. |

In Claude Code, prompts appear as slash commands, for example
`/mcp__nebari-apps__triage_app apps docs-site`.

### Untrusted output

Pod logs, inline source files and Kubernetes events (whose messages quote container output)
are written, directly or not, by whoever launched the app, and they land in the agent's
context. Tools and resources return them inside markers with a random nonce
(`<untrusted-1a2b…>` … `</untrusted-1a2b…>`) that the content cannot close early, next to
a `notice` telling the agent to treat the content as data, never as instructions. Logs are
capped to the last 64 KiB, events to the first (newest) 32 KiB and each inline file to its
first 16 KiB (`truncated` / `truncatedFiles` say when).

### Secrets

`launch_app` and `update_app` accept `secrets`, a map of environment variable names to
credentials. apps-api writes them to the app's own Kubernetes Secret and returns only the
names (`runtime.secretKeys`), so no tool, `get_app` and `list_apps` included, ever outputs a
value. Values an agent passes still appear in its own transcript, which coding agents often
log: the tool descriptions steer agents to ask the user to type credentials into the UI's
**Secrets** section instead, and never to put them in `env`.

### Sessions

Device-flow logins are kept in the MCP server's memory per MCP session, and dropped after
`MCP_SESSION_TTL_SECONDS` (default 8 hours) without use. A connection without a session
id cannot log in. Because sessions are in memory, `mcp.replicaCount` must stay 1.

Every tool returns structured JSON. Errors carry the API's human-readable `detail`, and a
`401` includes `nextAction: call the authenticate tool`, so agents can self-recover.

## Example agent flow

> *"Launch the site in ./docs-site as a public app called docs-site"*

1. `describe_cluster` → namespaces `["apps", ...]`, appsDomain `apps.example.ai`
2. `launch_app` with `source_type: inline`, the directory's files as
   `inline_files`, `public: true`, `subdomain: docs-site` (add `landing_page: true` to get a
   tile on the Nebari landing page; apps are hidden from it by default)
3. `get_app_status` until `phase: Running`
4. Report `https://docs-site.apps.example.ai` back to the user

For a Python app ("launch the pixi app in ./py-app with task `start`"), step 2 adds
`pixi_task: "start"` and the files must include a `pixi.toml` (or `pyproject.toml`).

Pair it with the [scaffolding skill](/skill/): the skill generates apps with a
`nebari-app.yaml` manifest, and "launch it" maps that manifest onto `launch_app` with no
ambiguity. Agents without the skill get the same steps from the `launch_from_manifest`
prompt.
