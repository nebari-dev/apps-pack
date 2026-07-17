---
name: new-nebari-app
description: Scaffold a web app for the Nebari Apps Pack — a static site (HTML/CSS/JS) or a Python app launched by a pixi task — with a nebari-app.yaml launch manifest, and launch it on the cluster through the nebari-apps MCP server. Use when the user wants to create, scaffold, or generate an app for Nebari, or says "launch it" about an app directory containing nebari-app.yaml.
---

# Scaffold and launch Nebari apps

Apps on a Nebari cluster are launched from one declarative contract. This skill scaffolds
app directories in that contract's layout — content plus a `nebari-app.yaml` manifest —
and maps the manifest onto the `nebari-apps` MCP server's `launch_app` tool so
"generate, then launch it" is one smooth flow. Two kinds of app are supported:

- **Static site**: HTML/CSS/JS served by the platform's nginx.
- **Python app (pixi)**: a source tree with a `pixi.toml`; the platform runs
  `pixi install` then `pixi run <task>` (set in `runtime.pixiTask`), and the task must
  start a server on **0.0.0.0:8080** (`PORT=8080` is injected).

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
   (public vs group-restricted) if the user hasn't said.

4. **Tell the user how to launch**, verbatim:
   > Say **"launch it"** and I'll deploy it to the cluster via the nebari-apps MCP server
   > (`https://apps.<cluster-domain>/mcp`).

## Launching ("launch it")

When the user asks to launch an app directory, read its `nebari-app.yaml` and drive the
`nebari-apps` MCP tools:

1. `describe_cluster` — confirm the target `namespace` is available and get `appsDomain`.
   If a tool returns an auth error, call `authenticate` and follow its instructions
   (show the user the verification URL + code, then retry).
2. Map the manifest to a `launch_app` call — the full mapping table is in
   [references/manifest.md](references/manifest.md). The common case:
   - **`source.type: files`**: read every text file under `files.path`
     (relative to the manifest) and pass them as `inline_files`
     (`{relative/path: content}`). Static apps must include `index.html`; pixi apps
     (`runtime.pixiTask` set → `pixi_task`) must include `pixi.toml` or
     `pyproject.toml`. Text files only; keep the total under ~900KB — if larger, push
     the directory to git and use a `git` source instead.
3. `launch_app` is **idempotent** on (namespace, name) — re-launching an existing app
   updates it, so retrying or iterating is safe.
4. Poll `get_app_status` until `phase` is `Running` (typically seconds for static apps;
   pixi apps resolve their environment on first start and can take a few minutes). If it
   lands in `Failed`, read `get_app_logs` and the status message, fix, re-launch.
5. Report the app's `url` back to the user.

## Conventions (do not deviate)

- Static content is served with nginx on **port 8080**; pixi tasks must serve on
  **0.0.0.0:8080** themselves. The gateway terminates TLS and, for non-public apps,
  enforces Keycloak SSO — **never add auth code to the app itself**.
- Keep `nebari-app.yaml` in version control — it is also the GitOps artifact: piped
  through `App` metadata, `kubectl apply` works on the rendered form.
