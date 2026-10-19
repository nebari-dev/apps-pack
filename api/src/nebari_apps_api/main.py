"""nebari-apps-api: REST API over App custom resources.

Every write renders an App CR; the apps-operator does the actual work. The
UI and (later) the MCP server are thin clients over this API.
"""

import json
from collections import Counter
from typing import Annotated, Any

from fastapi import Depends, FastAPI, File, Form, HTTPException, Query, Request, UploadFile

from . import cr as crmod
from .auth import User, can_access, current_user, is_admin
from .config import settings
from .k8s import AppStore, ConflictError, KubernetesAppStore, NotFoundError
from .models import (
    SOURCE_TYPES,
    AnalyticsSummary,
    AppCreate,
    AppMetrics,
    AppOut,
    AppPatch,
    AppUsage,
    Capabilities,
    ClusterMetrics,
    NamespaceUsage,
)
from .limits import BodySizeLimitMiddleware
from .upload import PIXI_MANIFESTS, files_from_upload, read_capped

PREFIX = "/api/v1"


def create_app(store: AppStore | None = None) -> FastAPI:
    app = FastAPI(title="nebari-apps-api", version="0.1.0")
    app.add_middleware(BodySizeLimitMiddleware, max_bytes=lambda: settings.max_request_bytes)
    app.state.store = store

    def get_store() -> AppStore:
        if app.state.store is None:
            app.state.store = KubernetesAppStore()
        return app.state.store

    Store = Annotated[AppStore, Depends(get_store)]
    Me = Annotated[User, Depends(current_user)]

    def launchable_namespaces(store: AppStore) -> list[str]:
        # The nebari-operator rejects NebariApps in "default" and system
        # namespaces, so never offer them even if labeled/configured.
        namespaces = settings.allowed_namespaces or store.list_managed_namespaces()
        return [ns for ns in namespaces if ns != "default" and not ns.startswith("kube-")]

    def check_namespace(store: AppStore, namespace: str) -> None:
        allowed = launchable_namespaces(store)
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

    def authorized_app(store: AppStore, user: User, namespace: str, name: str) -> dict[str, Any]:
        """Fetch an App the caller may act on: the path namespace must be a
        launchable namespace and the caller must own the App or be an admin.
        Every route that addresses one App goes through here."""
        check_namespace(store, namespace)
        cr = must_get(store, namespace, name)
        if not can_access(user, cr):
            raise HTTPException(403, f"you do not have access to app {namespace}/{name}")
        return cr

    def visible_apps(store: AppStore, user: User, namespace: str | None) -> list[dict[str, Any]]:
        """Apps the caller may see: launchable namespaces only, filtered by
        owner unless the caller is an admin."""
        if namespace is not None:
            check_namespace(store, namespace)
        allowed = launchable_namespaces(store)
        return [
            cr
            for cr in store.list_apps(namespace)
            if (cr.get("metadata") or {}).get("namespace") in allowed and can_access(user, cr)
        ]

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
            appsDomain=settings.apps_domain,
            sourceTypes=list(SOURCE_TYPES),
            namespaces=launchable_namespaces(store),
        )

    @app.get(PREFIX + "/auth/me")
    def me(user: Me) -> dict[str, Any]:
        return {
            "username": user.username,
            "email": user.email,
            "groups": user.groups,
            "admin": is_admin(user),
        }

    # ------------------------------------------------------------------ apps
    @app.get(PREFIX + "/apps", response_model=list[AppOut])
    def list_apps(store: Store, user: Me, namespace: str | None = None) -> list[AppOut]:
        return [crmod.from_cr(item) for item in visible_apps(store, user, namespace)]

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
        """Launch an app from an uploaded zip or .html file.

        A manifest with runtime.pixiTask set marks a Python/pixi app: the zip
        must contain a pixi manifest instead of an index.html.
        """
        try:
            data = json.loads(manifest)
        except json.JSONDecodeError as exc:
            raise HTTPException(400, f"manifest is not valid JSON: {exc}") from exc

        pixi = bool((data.get("runtime") or {}).get("pixiTask"))
        data_bytes = read_capped(file.file, settings.max_upload_bytes)
        files = files_from_upload(file.filename or "upload", data_bytes, pixi=pixi)
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
        return crmod.from_cr(authorized_app(store, user, namespace, name))

    @app.patch(PREFIX + "/apps/{namespace}/{name}", response_model=AppOut)
    def patch_app(namespace: str, name: str, patch: AppPatch, store: Store, user: Me) -> AppOut:
        _reject_users(patch.access)
        _check_source(patch.source)
        existing = authorized_app(store, user, namespace, name)
        updated = store.replace_app(namespace, name, crmod.apply_patch(existing, patch))
        return crmod.from_cr(updated)

    @app.delete(PREFIX + "/apps/{namespace}/{name}", status_code=204)
    def delete_app(namespace: str, name: str, store: Store, user: Me) -> None:
        authorized_app(store, user, namespace, name)
        store.delete_app(namespace, name)

    def _scale(store: AppStore, user: User, namespace: str, name: str, replicas: int) -> AppOut:
        existing = authorized_app(store, user, namespace, name)
        runtime = existing.setdefault("spec", {}).setdefault("runtime", {})
        runtime["replicas"] = replicas
        return crmod.from_cr(store.replace_app(namespace, name, existing))

    @app.post(PREFIX + "/apps/{namespace}/{name}/stop", response_model=AppOut)
    def stop_app(namespace: str, name: str, store: Store, user: Me) -> AppOut:
        return _scale(store, user, namespace, name, 0)

    @app.post(PREFIX + "/apps/{namespace}/{name}/start", response_model=AppOut)
    def start_app(namespace: str, name: str, store: Store, user: Me) -> AppOut:
        return _scale(store, user, namespace, name, 1)

    @app.post(PREFIX + "/apps/{namespace}/{name}/restart", response_model=AppOut)
    def restart_app(namespace: str, name: str, store: Store, user: Me) -> AppOut:
        authorized_app(store, user, namespace, name)
        try:
            store.restart_app(namespace, name)
        except NotFoundError as exc:
            raise HTTPException(409, f"app {namespace}/{name} is not running") from exc
        return crmod.from_cr(must_get(store, namespace, name))

    # --------------------------------------------------------- observability
    @app.get(PREFIX + "/apps/{namespace}/{name}/status")
    def app_status(namespace: str, name: str, store: Store, user: Me) -> dict[str, Any]:
        return crmod.from_cr(authorized_app(store, user, namespace, name)).status.model_dump()

    @app.get(PREFIX + "/apps/{namespace}/{name}/logs")
    def app_logs(
        namespace: str,
        name: str,
        store: Store,
        user: Me,
        lines: Annotated[int, Query(ge=1, le=5000)] = 200,
        container: str | None = None,
    ) -> dict[str, str]:
        authorized_app(store, user, namespace, name)
        try:
            return {"logs": store.pod_logs(namespace, name, lines, container)}
        except NotFoundError as exc:
            raise HTTPException(404, str(exc)) from None

    @app.get(PREFIX + "/apps/{namespace}/{name}/events")
    def app_events(namespace: str, name: str, store: Store, user: Me) -> list[dict[str, Any]]:
        authorized_app(store, user, namespace, name)
        return store.app_events(namespace, name)

    @app.get(PREFIX + "/apps/{namespace}/{name}/metrics", response_model=AppMetrics)
    def app_metrics(namespace: str, name: str, store: Store, user: Me) -> AppMetrics:
        authorized_app(store, user, namespace, name)
        try:
            pods = store.pod_metrics(namespace, name)
        except NotFoundError:
            return AppMetrics(available=False, pods=[])
        return AppMetrics(available=True, pods=pods)

    # -------------------------------------------------------------- analytics
    @app.get(PREFIX + "/analytics/summary", response_model=AnalyticsSummary)
    def analytics_summary(store: Store, user: Me, namespace: str | None = None) -> AnalyticsSummary:
        apps = [crmod.from_cr(item) for item in visible_apps(store, user, namespace)]
        by_phase = Counter(a.status.phase or "Pending" for a in apps)
        by_source_type = Counter(a.source.type if a.source else "unknown" for a in apps)
        by_namespace = Counter(a.namespace for a in apps)
        ready = sum(a.status.replicas.ready if a.status.replicas else 0 for a in apps)
        desired = sum(a.status.replicas.desired if a.status.replicas else 0 for a in apps)
        return AnalyticsSummary(
            total=len(apps),
            byPhase=dict(by_phase),
            bySourceType=dict(by_source_type),
            byNamespace=dict(by_namespace),
            readyReplicas=ready,
            desiredReplicas=desired,
        )

    @app.get(PREFIX + "/analytics/metrics", response_model=ClusterMetrics)
    def cluster_metrics(store: Store, user: Me) -> ClusterMetrics:
        """Right-now resource usage per app and namespace, plus restart counts.

        Restart counts always populate (pod status); CPU/memory populate only when
        the cluster has a metrics server (usageAvailable=false otherwise).
        """
        # Only pods of Apps the caller may see contribute.
        visible = {
            ((cr.get("metadata") or {}).get("namespace", ""), (cr.get("metadata") or {}).get("name", ""))
            for cr in visible_apps(store, user, None)
        }
        # (namespace, app) -> aggregated usage across its pods
        agg: dict[tuple[str, str], dict[str, int]] = {}

        def entry(ns: str, name: str) -> dict[str, int]:
            return agg.setdefault((ns, name), {"cpu": 0, "memory": 0, "restarts": 0})

        usage_available = True
        try:
            for pod in store.cluster_pod_metrics():
                if (pod["namespace"], pod["app"]) not in visible:
                    continue
                e = entry(pod["namespace"], pod["app"])
                e["cpu"] += int(pod.get("cpu", 0))
                e["memory"] += round(pod.get("memory", 0))
        except NotFoundError:
            usage_available = False

        for pod in store.app_restarts():
            if (pod["namespace"], pod["app"]) not in visible:
                continue
            entry(pod["namespace"], pod["app"])["restarts"] += int(pod.get("restarts", 0))

        apps = [
            AppUsage(namespace=ns, name=name, cpu=v["cpu"], memory=v["memory"], restarts=v["restarts"])
            for (ns, name), v in agg.items()
        ]
        apps.sort(key=lambda a: (a.cpu, a.memory), reverse=True)

        ns_agg: dict[str, dict[str, int]] = {}
        for a in apps:
            n = ns_agg.setdefault(a.namespace, {"cpu": 0, "memory": 0})
            n["cpu"] += a.cpu
            n["memory"] += a.memory
        by_namespace = [
            NamespaceUsage(namespace=ns, cpu=v["cpu"], memory=v["memory"]) for ns, v in ns_agg.items()
        ]
        by_namespace.sort(key=lambda n: (n.cpu, n.memory), reverse=True)

        return ClusterMetrics(usageAvailable=usage_available, apps=apps, byNamespace=by_namespace)

    return app


USERS_NOT_SUPPORTED = (
    "access.users is not supported yet: nothing enforces it, so it is rejected rather than "
    "silently ignored. Use access.groups (see https://github.com/nebari-dev/apps-pack/issues/67)."
)


def _reject_users(access: Any) -> None:
    if access is not None and access.users:
        raise HTTPException(422, USERS_NOT_SUPPORTED)


def _check_source(source: Any) -> None:
    if source is not None and source.type == "git" and source.git is not None:
        try:
            source.git.check()
        except ValueError as exc:
            raise HTTPException(422, f"source.git: {exc}") from None


def _validate_request(req: AppCreate) -> None:
    _reject_users(req.access)
    _check_source(req.source)
    if getattr(req.source, req.source.type, None) is None:
        raise HTTPException(422, f"source.{req.source.type} is required for source type {req.source.type!r}")
    if req.runtime.pixiTask and req.source.type == "inline":
        files = req.source.inline.files if req.source.inline else {}
        if not any(m in files for m in PIXI_MANIFESTS):
            raise HTTPException(
                422, "pixi apps need a pixi.toml or pyproject.toml at the source root"
            )


app = create_app()
