---
name: new-nebari-app
description: Scaffold a web app for the Nebari Apps Pack — a static site (HTML/CSS/JS) or a Python app launched by a pixi task — with a nebari-app.yaml launch manifest, and launch it on the cluster through the nebari-apps MCP server. Use when the user wants to create, scaffold, or generate an app for Nebari, or says "launch it" about an app directory containing nebari-app.yaml.
---

# Scaffold and launch Nebari apps

Apps on a Nebari cluster are launched from one declarative contract. This skill scaffolds
app directories in that contract's layout — content plus a `nebari-app.yaml` manifest —
and maps the manifest onto the `nebari-apps` MCP server's `launch_app` tool so
"generate, then launch it" is one smooth flow. Two kinds of app are scaffolded:

- **Static site**: HTML/CSS/JS served by the platform's nginx.
- **Python app (pixi)**: a source tree with a `pixi.toml`; the platform runs
  `pixi install` then `pixi run <task>` (set in `runtime.pixiTask`), and the task must
  start a server on **0.0.0.0:$PORT** (`PORT` is injected: 8080, or 8081 when the app
  can idle).

A third kind needs no scaffolding: an app that already ships as a **container image**. When
`describe_cluster` lists `image` in `sourceTypes`, write a manifest with `source.type: image`
(the image's reference with a tag or digest from one of `imageRegistries`, and the port it
listens on) and launch it the same way. Do not write a Dockerfile or try to build an image:
the user brings a published one.

## The layout

Every app is a directory with a `nebari-app.yaml` next to the content:

```
docs-site/                     py-app/
  nebari-app.yaml                nebari-app.yaml
  index.html                     pixi.toml
  styles.css                     app.py
```

The manifest maps 1:1 onto the pack's `App` resource — see
[references/manifest.md](references/manifest.md) for the full schema.

## Scaffolding

1. **Pick names.** Directory and app name: lowercase letters, digits, hyphens (max 53
   chars). Default the `subdomain` to the app name — the app's URL becomes
   `http(s)://<subdomain>.<appsDomain>`.

2. **Scaffold from the template** in [assets/](assets/): `assets/static/` for a static
   site (a real `index.html` + `styles.css`, manifest with `source.type: files`), or
   `assets/python/` for a pixi app (`pixi.toml` with a `start` task, `app.py`, manifest
   with `runtime.pixiTask: start`). Author actual files; never hand-write inline YAML
   content.

3. **Write `nebari-app.yaml`** with real values, not placeholders. Ask about access
   (public vs group-restricted) if the user hasn't said. Only set `landingPage.enabled: true`
   if the user wants the app on the Nebari landing page; apps are hidden from it by default.

4. **Tell the user how to launch**, verbatim:
   > Say **"launch it"** and I'll deploy it to the cluster via the nebari-apps MCP server
   > (`https://apps.<cluster-domain>/mcp`).

## Launching ("launch it")

When the user asks to launch an app directory, read its `nebari-app.yaml` and drive the
`nebari-apps` MCP tools. The server's `launch_from_manifest` prompt (argument `path`: the
manifest or its directory) returns these same steps; get it when your client supports MCP
prompts, and use the `triage_app` prompt (`namespace`, `name`) if the app lands in `Failed`:

1. `describe_cluster` — confirm the target `namespace` is available and get `appsDomain`.
   If a tool returns an auth error, ask the user to sign in to the `nebari-apps` server
   (in Claude Code: `/mcp`, select it, **Authenticate**; the browser login is the
   client's, not a tool), then retry.
2. Map the manifest to a `launch_app` call — the full mapping table is in
   [references/manifest.md](references/manifest.md). The common case:
   - **`source.type: files`**: read every text file under `files.path`
     (relative to the manifest) and pass them as `inline_files`
     (`{relative/path: content}`). Static apps must include `index.html`; pixi apps
     (`runtime.pixiTask` set → `pixi_task`) must include `pixi.toml` or
     `pyproject.toml`. Text files only; keep the total under ~900KB — if larger, push
     the directory to git and use a `git` source instead.
   - **`runtime.secretKeys`**: names only. Never put credentials in `env`, the manifest
     or any committed file; supply them out of band as described in
     [references/manifest.md#secrets](references/manifest.md#secrets) (the user enters them
     in the Apps UI's **Secrets** section, or hands them to you for `secrets`).
3. `launch_app` is **idempotent** on (namespace, name) — re-launching an existing app
   updates it, so retrying or iterating is safe.
4. Poll `get_app_status` until `phase` is `Running` (typically seconds for static apps;
   pixi apps resolve their environment on first start and can take a few minutes). If it
   lands in `Failed`, follow the `triage_app` prompt (or read the status conditions, then
   the `nebari-apps://apps/<namespace>/<name>/events` resource, then `get_app_logs`), fix,
   re-launch.
   `Idle` is not a failure: the app was scaled to zero after its idle timeout and its URL
   wakes it (or call `start_app`).
5. Report the app's `url` back to the user.

## Conventions (do not deviate)

- Static content is served with nginx on **port 8080**; pixi tasks must serve on
  **0.0.0.0:$PORT** themselves. The gateway terminates TLS and, for non-public apps,
  enforces Keycloak SSO — **never add auth code to the app itself**.
- **No credentials in the app directory.** Not in `nebari-app.yaml`, `runtime.env`, a
  `.env` or source files: list their names in `runtime.secretKeys` and read them from the
  environment at runtime.
- Keep `nebari-app.yaml` in version control — it is also the GitOps artifact: piped
  through `App` metadata, `kubectl apply` works on the rendered form.
