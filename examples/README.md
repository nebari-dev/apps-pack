# Example App resources

Sample `App` custom resources (`apps.nebari.dev/v1alpha1`) for the
apps-operator. Apply them into any namespace labeled
`nebari.dev/managed=true`:

```bash
kubectl label namespace apps nebari.dev/managed=true
kubectl apply -n apps -f static-inline-app.yaml
kubectl get apps -n apps -w
```

| File | What it shows |
|---|---|
| `static-inline-app.yaml` | Public static site with files carried inline in the CR (ConfigMap-backed). |
| `static-git-app.yaml` | Group-restricted static site cloned from git by an init container; Keycloak SSO at the gateway. |
| `python-inline-app.yaml` | Minimal Python app carried inline (stdlib http.server) launched by a pixi task (`runtime.pixiTask`). |
| `python-git-app.yaml` | Real Streamlit app cloned from git and launched by `pixi run start`. |
| `python-app/` | The Streamlit app `python-git-app.yaml` points at (`subdir: examples/python-app`): `pixi.toml`, `pixi.lock`, `app.py`, and a `nebari-app.yaml` for agent launches. |
| `web-terminal/` | An interactive **bash shell in the browser** via [ttyd](https://github.com/tsl0922/ttyd), with vim, nano, git, gh, curl, wget, ssh, jq, yq, ripgrep, fd, bat, htop, tree, tmux, fzf, make, zip/unzip and Python on PATH — all from conda-forge via `pixi.toml`, no image build. `terminal.sh` + `bashrc` give the shell a prompt, git identity and a username (app pods run as UID 65532 with no passwd entry — nss_wrapper fixes that fully on linux-64; elsewhere the prompt falls back to `$USER`). SSO-gated (`access.public: false`) because it is a shell. |
| `static/` | The content `static-git-app.yaml` points at (`subdir: examples/static`). |

The operator reconciles each `App` into a Deployment, a Service, and a
`NebariApp` (routing + TLS + auth + landing-page tile). Delete the `App` and
everything cascades.
