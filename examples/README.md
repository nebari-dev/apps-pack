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
| `site/` | The content `static-git-app.yaml` points at (`subdir: examples/site`). |

The operator reconciles each `App` into a Deployment, a Service, and a
`NebariApp` (routing + TLS + auth + landing-page tile). Delete the `App` and
everything cascades.
