"""nebari-apps-api: REST API over App custom resources.

Every write renders an App CR; the apps-operator does the actual work. The
UI and (later) the MCP server are thin clients over this API.
"""

import json
from collections import Counter
from typing import Annotated, Any

from fastapi import Depends, FastAPI, File, Form, HTTPException, Query, Request, UploadFile

from . import cr as crmod
from .auth import User, current_user
from .config import settings
from .frameworks import FRAMEWORKS, FRAMEWORKS_BY_NAME
from .k8s import AppStore, ConflictError, KubernetesAppStore, NotFoundError
from .models import (
    AnalyticsSummary,
    AppCreate,
    AppOut,
    AppPatch,
    Capabilities,
    FrameworkInfo,
)
from .upload import files_from_upload

PREFIX = "/api/v1"


def create_app(store: AppStore | None = None) -> FastAPI:
    app = FastAPI(title="nebari-apps-api", version="0.1.0")
    app.state.store = store

    def get_store() -> AppStore:
        if app.state.store is None:
            app.state.store = KubernetesAppStore()
        return app.state.store

    Store = Annotated[AppStore, Depends(get_store)]
    Me = Annotated[User, Depends(current_user)]

    def check_namespace(store: AppStore, namespace: str) -> None:
        allowed = settings.allowed_namespaces or store.list_managed_namespaces()
        if namespace not in allowed:
            raise HTTPException(
                403,
                f"namespace {namespace!r} is not available for apps "
                f"(managed namespaces: {', '.join(allowed) or 'none'})",
            )

    def must_get(store: AppStore, namespace: str, name: str) -> dict[str, Any]:
        try:
            return store.get_app(namespace, name)
        except NotFoundError:
            raise HTTPException(404, f"app {namespace}/{name} not found") from None

    # ------------------------------------------------------------------ meta
    @app.get(PREFIX + "/healthz", include_in_schema=False)
    def healthz() -> dict[str, str]:
        return {"status": "ok"}

    @app.get(PREFIX + "/config")
    def ui_config() -> dict[str, Any]:
        """Public bootstrap config for the UI (keycloak-js)."""
        return {
            "authEnabled": settings.auth_enabled,
            "keycloak": {
                "url": settings.ui_keycloak_url,
                "realm": settings.ui_keycloak_realm,
                "clientId": settings.ui_keycloak_client_id,
            },
            "appsDomain": settings.apps_domain,
            "appsScheme": "http" if settings.tls_disabled else "https",
        }

    @app.get(PREFIX + "/capabilities", response_model=Capabilities)
    def capabilities(store: Store, user: Me) -> Capabilities:
        return Capabilities(
            nebi=False,
            environments="none",
            appsDomain=settings.apps_domain,
            frameworks=[f.name for f in FRAMEWORKS],
            namespaces=settings.allowed_namespaces or store.list_managed_namespaces(),
        )

    @app.get(PREFIX + "/frameworks", response_model=list[FrameworkInfo])
    def frameworks(user: Me) -> list[FrameworkInfo]:
        return FRAMEWORKS

    @app.get(PREFIX + "/environments")
    def environments(user: Me) -> list[dict[str, Any]]:
        """Pixi environments from Nebi - empty until the Nebi integration lands."""
        return []

    @app.get(PREFIX + "/auth/me")
    def me(user: Me) -> dict[str, Any]:
        return {"username": user.username, "email": user.email, "groups": user.groups}

    # ------------------------------------------------------------------ apps
    @app.get(PREFIX + "/apps", response_model=list[AppOut])
    def list_apps(store: Store, user: Me, namespace: str | None = None) -> list[AppOut]:
        return [crmod.from_cr(item) for item in store.list_apps(namespace)]

    @app.post(PREFIX + "/apps", response_model=AppOut, status_code=201)
    def create(req: AppCreate, store: Store, user: Me) -> AppOut:
        _validate_request(req)
        check_namespace(store, req.namespace)
        try:
            created = store.create_app(req.namespace, crmod.to_cr(req, user.username))
        except ConflictError:
            raise HTTPException(409, f"app {req.namespace}/{req.name} already exists") from None
        return crmod.from_cr(created)

    @app.post(PREFIX + "/apps/upload", response_model=AppOut, status_code=201)
    def create_from_upload(
        store: Store,
        user: Me,
        manifest: Annotated[str, Form(description="AppCreate JSON, source omitted")],
        file: Annotated[UploadFile, File(description="zip archive or single .html file")],
    ) -> AppOut:
        """Launch a static app from an uploaded zip or .html file."""
        try:
            data = json.loads(manifest)
        except json.JSONDecodeError as exc:
            raise HTTPException(400, f"manifest is not valid JSON: {exc}") from exc

        files = files_from_upload(file.filename or "upload", file.file.read())
        data["framework"] = data.get("framework", "static")
        data["source"] = {"type": "inline", "inline": {"files": files}}
        req = AppCreate.model_validate(data)

        _validate_request(req)
        check_namespace(store, req.namespace)
        try:
            created = store.create_app(req.namespace, crmod.to_cr(req, user.username))
        except ConflictError:
            raise HTTPException(409, f"app {req.namespace}/{req.name} already exists") from None
        return crmod.from_cr(created)

    @app.get(PREFIX + "/apps/{namespace}/{name}", response_model=AppOut)
    def get_app(namespace: str, name: str, store: Store, user: Me) -> AppOut:
        return crmod.from_cr(must_get(store, namespace, name))

    @app.patch(PREFIX + "/apps/{namespace}/{name}", response_model=AppOut)
    def patch_app(namespace: str, name: str, patch: AppPatch, store: Store, user: Me) -> AppOut:
        existing = must_get(store, namespace, name)
        updated = store.replace_app(namespace, name, crmod.apply_patch(existing, patch))
        return crmod.from_cr(updated)

    @app.delete(PREFIX + "/apps/{namespace}/{name}", status_code=204)
    def delete_app(namespace: str, name: str, store: Store, user: Me) -> None:
        must_get(store, namespace, name)
        store.delete_app(namespace, name)

    def _scale(store: AppStore, namespace: str, name: str, replicas: int) -> AppOut:
        existing = must_get(store, namespace, name)
        runtime = existing.setdefault("spec", {}).setdefault("runtime", {})
        runtime["replicas"] = replicas
        return crmod.from_cr(store.replace_app(namespace, name, existing))

    @app.post(PREFIX + "/apps/{namespace}/{name}/stop", response_model=AppOut)
    def stop_app(namespace: str, name: str, store: Store, user: Me) -> AppOut:
        return _scale(store, namespace, name, 0)

    @app.post(PREFIX + "/apps/{namespace}/{name}/start", response_model=AppOut)
    def start_app(namespace: str, name: str, store: Store, user: Me) -> AppOut:
        return _scale(store, namespace, name, 1)

    # --------------------------------------------------------- observability
    @app.get(PREFIX + "/apps/{namespace}/{name}/status")
    def app_status(namespace: str, name: str, store: Store, user: Me) -> dict[str, Any]:
        return crmod.from_cr(must_get(store, namespace, name)).status.model_dump()

    @app.get(PREFIX + "/apps/{namespace}/{name}/logs")
    def app_logs(
        namespace: str,
        name: str,
        store: Store,
        user: Me,
        lines: Annotated[int, Query(ge=1, le=5000)] = 200,
        container: str | None = None,
    ) -> dict[str, str]:
        must_get(store, namespace, name)
        try:
            return {"logs": store.pod_logs(namespace, name, lines, container)}
        except NotFoundError as exc:
            raise HTTPException(404, str(exc)) from None

    @app.get(PREFIX + "/apps/{namespace}/{name}/events")
    def app_events(namespace: str, name: str, store: Store, user: Me) -> list[dict[str, Any]]:
        must_get(store, namespace, name)
        return store.app_events(namespace, name)

    # -------------------------------------------------------------- analytics
    @app.get(PREFIX + "/analytics/summary", response_model=AnalyticsSummary)
    def analytics_summary(store: Store, user: Me, namespace: str | None = None) -> AnalyticsSummary:
        apps = [crmod.from_cr(item) for item in store.list_apps(namespace)]
        by_phase = Counter(a.status.phase or "Pending" for a in apps)
        by_framework = Counter(a.framework for a in apps)
        by_namespace = Counter(a.namespace for a in apps)
        ready = sum(a.status.replicas.ready if a.status.replicas else 0 for a in apps)
        desired = sum(a.status.replicas.desired if a.status.replicas else 0 for a in apps)
        return AnalyticsSummary(
            total=len(apps),
            byPhase=dict(by_phase),
            byFramework=dict(by_framework),
            byNamespace=dict(by_namespace),
            readyReplicas=ready,
            desiredReplicas=desired,
        )

    return app


def _validate_request(req: AppCreate) -> None:
    fw = FRAMEWORKS_BY_NAME.get(req.framework)
    if fw is None:
        raise HTTPException(422, f"unknown framework {req.framework!r}")
    if req.source.type not in fw.sourceTypes:
        raise HTTPException(
            422, f"framework {req.framework!r} does not support source type {req.source.type!r}"
        )
    if req.source.type not in fw.implementedSources:
        raise HTTPException(
            422,
            f"framework {req.framework!r} with source {req.source.type!r} is not available yet "
            "(pixi environments via Nebi land in Phase 2)",
        )
    if req.framework == "custom" and not req.runtime.command:
        raise HTTPException(422, "framework 'custom' requires runtime.command")
    source_field = getattr(req.source, req.source.type if req.source.type != "ociEnv" else "ociEnv", None)
    if source_field is None:
        raise HTTPException(422, f"source.{req.source.type} is required for source type {req.source.type!r}")


app = create_app()
