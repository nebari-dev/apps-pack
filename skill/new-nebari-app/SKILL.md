---
name: new-nebari-app
description: Scaffold a static web app (HTML/CSS/JS) in the layout the Nebari Apps Pack expects, with a nebari-app.yaml launch manifest, and launch it on the cluster through the nebari-apps MCP server. Use when the user wants to create, scaffold, or generate an app for Nebari, or says "launch it" about an app directory containing nebari-app.yaml.
---

# Scaffold and launch Nebari apps

Apps on a Nebari cluster are launched from one declarative contract. This skill scaffolds
static app directories in that contract's layout — content plus a `nebari-app.yaml`
manifest — and maps the manifest onto the `nebari-apps` MCP server's `launch_app` tool so
"generate, then launch it" is one smooth flow.

## The layout

Every app is a directory with a `nebari-app.yaml` next to the content:

```
docs-site/
  nebari-app.yaml
  index.html
  styles.css
```

The manifest maps 1:1 onto the pack's `App` resource — see
[references/manifest.md](references/manifest.md) for the full schema.

## Scaffolding

1. **Pick names.** Directory and app name: lowercase letters, digits, hyphens (max 53
   chars). Default the `subdomain` to the app name — the app's URL becomes
   `http(s)://<subdomain>.<appsDomain>`.

2. **Scaffold from the template** in [assets/static/](assets/): a real `index.html`
   (+ `styles.css`), manifest with `source.type: files`. Author actual files; never
   hand-write inline YAML content.

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
     (`{relative/path: content}`). Must include `index.html`; text assets only; keep the
     total under ~900KB — if larger, push the directory to git and use a `git` source
     instead.
3. `launch_app` is **idempotent** on (namespace, name) — re-launching an existing app
   updates it, so retrying or iterating is safe.
4. Poll `get_app_status` until `phase` is `Running` (typically seconds). If it lands in
   `Failed`, read `get_app_logs` and the status message, fix, re-launch.
5. Report the app's `url` back to the user.

## Conventions (do not deviate)

- The platform serves content with nginx on **port 8080**. The gateway terminates TLS and,
  for non-public apps, enforces Keycloak SSO — **never add auth code to the app itself**.
- Keep `nebari-app.yaml` in version control — it is also the GitOps artifact: piped
  through `App` metadata, `kubectl apply` works on the rendered form.
