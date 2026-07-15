# APP_DISPLAY_NAME

A Streamlit app deployed with the [Nebari Apps Pack](https://packs.nebari.dev/nebari-apps-pack/).

## Local development

```bash
pixi run dev            # http://localhost:8501
```

## Deploy

```bash
docker build -t REGISTRY/APP_NAME:v1 .
docker push REGISTRY/APP_NAME:v1
```

Then say **"launch it"** to a coding agent connected to the nebari-apps MCP server, or use
the Apps UI / API with the values from `nebari-app.yaml`. The app comes up at
`http(s)://APP_NAME.<appsDomain>` behind Keycloak SSO (unless `access.public: true`).
