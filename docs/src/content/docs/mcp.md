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
  MCP can never act with more privilege than the calling user.

On clusters with auth disabled, `authenticate` reports `not_required` and every tool works
anonymously.

## Tools

| Tool | Purpose |
|---|---|
| `authenticate` | Start/complete the device-flow login, or confirm the cached token. |
| `describe_cluster` | Frameworks, launchable namespaces, apps domain, Nebi availability — call first to pick valid options. |
| `list_frameworks` | Frameworks with allowed and implemented source types. |
| `list_environments` | Nebi pixi environments (empty until that integration lands). |
| `launch_app` | Create + launch. **Idempotent on (namespace, name)** — re-launching updates instead of failing, so retries are safe. |
| `list_apps` | Apps with phase, URL, owner; optional namespace filter. |
| `get_app` | Full spec + status for one app. |
| `get_app_status` | Lightweight poll: phase, URL, replicas, conditions. |
| `get_app_logs` | Recent pod logs — first stop when phase is `Failed`. |
| `update_app` | Patch spec (source, runtime, access, …). |
| `stop_app` / `start_app` | Scale to zero / back up. |
| `remove_app` | Delete permanently (cascades; the tool description tells agents to confirm with the user). |

Every tool returns structured JSON. Errors carry the API's human-readable `detail`, and a
`401` includes `nextAction: call the authenticate tool`, so agents can self-recover.

## Example agent flow

> *"Launch the site in ./docs-site as a public app called docs-site"*

1. `describe_cluster` → namespaces `["apps", ...]`, appsDomain `apps.example.ai`
2. `launch_app` with `framework: static`, `source_type: inline`, the directory's files as
   `inline_files`, `public: true`, `subdomain: docs-site`
3. `get_app_status` until `phase: Running`
4. Report `https://docs-site.apps.example.ai` back to the user

Pair it with the [scaffolding skill](/skill/): the skill generates apps with a
`nebari-app.yaml` manifest, and "launch it" maps that manifest onto `launch_app` with no
ambiguity.
