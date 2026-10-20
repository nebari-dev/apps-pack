---
title: MCP server
---

The **apps-mcp** server lets coding agents (Claude Code, Codex, or any MCP client) launch
and manage apps with natural language. It is a thin, well-described tool layer over the
[REST API](/api-reference/) — no business logic of its own, so agent launches behave exactly
like UI launches.

**Endpoint:** `https://apps.<cluster-domain>/mcp` (streamable HTTP — the UI's nginx proxies
`/mcp` to the MCP service, so the whole platform lives on one hostname).

## Connecting

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
  against the realm JWKS before *any* tool logic runs. Every tool except `authenticate`
  (the login bootstrap) is rejected for anonymous or forged callers with an error telling
  the agent to call `authenticate`.
- **At the API layer** — apps-api independently validates the JWT on every request, so the
  MCP can never act with more privilege than the calling user: an agent sees and manages
  only the apps its user owns (or every app, for members of an admin group).

On clusters with auth disabled, `authenticate` reports `not_required` and every tool works
anonymously.

## Tools

| Tool | Purpose |
|---|---|
| `authenticate` | Start/complete the device-flow login, or confirm the cached token. |
| `describe_cluster` | Source types, launchable namespaces, apps domain — call first to pick valid options. |
| `launch_app` | Create + launch (static, or Python/pixi via `pixi_task`); optional `resources` (requests/limits, cluster defaults otherwise) and `groups`/`users` to restrict a private app (a member of any group or a listed user gets in; everyone else gets `403`). **Idempotent on (namespace, name)** — re-launching your own app updates it instead of failing, so retries are safe; an app owned by someone else is refused, never overwritten. |
| `list_apps` | Apps with phase, URL, owner; optional namespace filter. Inline sources list file `paths` only. |
| `get_app` | Full spec + status for one app; inline files come back fenced (see below). |
| `get_app_status` | Lightweight poll: phase, URL, replicas, conditions. |
| `get_app_logs` | Recent pod logs (fenced, last 64 KiB) — first stop when phase is `Failed`. |
| `update_app` | Patch spec (source, runtime, access, …). |
| `stop_app` / `start_app` | Scale to zero / back up. |
| `restart_app` | Roll the app's pods without changing the spec; fails if the app is stopped. |
| `get_app_metrics` | Instantaneous CPU/memory per pod (`available:false` when the cluster has no metrics server). |
| `remove_app` | Delete permanently (cascades). Refused unless called with `confirm: true`, which the agent sets only after the user agrees. |

Every tool carries MCP annotations, so clients that auto-approve tools can tell them
apart: `describe_cluster`, `list_apps`, `get_app`, `get_app_status`, `get_app_logs` and
`get_app_metrics` are `readOnlyHint`; `launch_app` (it updates an existing app),
`update_app`, `stop_app` and `remove_app` are `destructiveHint`.

### Untrusted output

Pod logs and inline source files are written by whoever launched the app, and they land in
the agent's context. Tools return them inside markers with a random nonce
(`<untrusted-1a2b…>` … `</untrusted-1a2b…>`) that the content cannot close early, next to
a `notice` telling the agent to treat the content as data, never as instructions. Logs are
capped to the last 64 KiB and each inline file to its first 16 KiB (`truncated` /
`truncatedFiles` say when).

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
ambiguity.
