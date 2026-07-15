---
name: new-nebari-app
description: Scaffold a web app (static site or Python app) in the layout the Nebari Apps Pack expects, with a nebari-app.yaml launch manifest, and launch it on the cluster through the nebari-apps MCP server. Use when the user wants to create, scaffold, or generate an app for Nebari, or says "launch it" about an app directory containing nebari-app.yaml.
---

# Scaffold and launch Nebari apps

Apps on a Nebari cluster are launched from one declarative contract. This skill scaffolds
app directories in that contract's layout — code plus a `nebari-app.yaml` manifest — and
maps the manifest onto the `nebari-apps` MCP server's `launch_app` tool so "generate, then
launch it" is one smooth flow.

## The layout

Every app is a directory with a `nebari-app.yaml` next to the code:

```
docs-site/                    sales-dashboard/
  nebari-app.yaml               nebari-app.yaml
  index.html                    app.py
  styles.css                    pixi.toml          # local dev env (pixi run dev)
                                Dockerfile         # deployment image (port 8080)
                                README.md
```

The manifest maps 1:1 onto the pack's `App` resource — see
[references/manifest.md](references/manifest.md) for the full schema.

## Scaffolding

1. **Determine the kind of app.** Static (HTML/CSS/JS) or Python
   (`streamlit | panel | gradio | dash | voila | fastapi | custom`). If the user's intent
   is ambiguous, ask. Data apps default to `streamlit`; HTTP services to `fastapi`.

2. **Pick names.** Directory and app name: lowercase letters, digits, hyphens (max 53
   chars). Default the `subdomain` to the app name — the app's URL becomes
   `http(s)://<subdomain>.<appsDomain>`.

3. **Scaffold from the templates** in [assets/](assets/):
   - **Static** — `assets/static/`: a real `index.html` (+ `styles.css`), manifest with
     `source.type: files`. Author actual files; never hand-write inline YAML content.
   - **Streamlit** — `assets/streamlit/`: `app.py`, `pixi.toml`, `Dockerfile`.
   - **FastAPI** — `assets/fastapi/`: `app.py`, `pixi.toml`, `Dockerfile`.
   - **Other Python frameworks** — adapt the streamlit template: swap the framework
     dependency in `pixi.toml` and the `CMD` in the Dockerfile (the app must listen on
     `0.0.0.0:8080`; see the framework table in references/manifest.md).

4. **Write `nebari-app.yaml`** with real values, not placeholders. Ask about access
   (public vs group-restricted) if the user hasn't said.

5. **Tell the user how to launch**, verbatim:
   > Say **"launch it"** and I'll deploy it to the cluster via the nebari-apps MCP server
   > (`https://apps.<cluster-domain>/mcp`).

## Launching ("launch it")

When the user asks to launch an app directory, read its `nebari-app.yaml` and drive the
`nebari-apps` MCP tools:

1. `describe_cluster` — confirm the target `namespace` is available and get `appsDomain`.
   If a tool returns an auth error, call `authenticate` and follow its instructions
   (show the user the verification URL + code, then retry).
2. Map the manifest to a `launch_app` call — the full mapping table is in
   [references/manifest.md](references/manifest.md). The two common cases:
   - **`source.type: files`** (static): read every text file under `files.path`
     (relative to the manifest) and pass them as `inline_files`
     (`{relative/path: content}`). Must include `index.html`; text assets only; keep the
     total under ~900KB — if larger, push the directory to git and use a `git` source
     instead.
   - **`source.type: image`** (Python): the image must be **built and pushed first**
     (`docker build`/`push` with the scaffolded Dockerfile) — the cluster pulls it; it
     cannot see local images. Then pass `image_repository` + `image_tag`.
3. `launch_app` is **idempotent** on (namespace, name) — re-launching an existing app
   updates it, so retrying or iterating is safe.
4. Poll `get_app_status` until `phase` is `Running` (static apps: seconds; image pulls can
   take a minute or two). If it lands in `Failed`, read `get_app_logs` and the status
   message, fix, re-launch.
5. Report the app's `url` back to the user.

## Conventions (do not deviate)

- Apps listen on **port 8080**, bound to `0.0.0.0`. The gateway terminates TLS and, for
  non-public apps, enforces Keycloak SSO — **never add auth code to the app itself**.
- Container images must run as a **non-root** user (the scaffolded Dockerfiles already do).
- `pixi.toml` defines the local dev environment (`pixi run dev`); today deployment goes
  through the Dockerfile, and the same `pixi.toml` will drive Nebi `ociEnv` launches when
  that lands (keep both in sync when adding dependencies).
- Keep `nebari-app.yaml` in version control — it is also the GitOps artifact: piped
  through `App` metadata, `kubectl apply` works on the rendered form.
