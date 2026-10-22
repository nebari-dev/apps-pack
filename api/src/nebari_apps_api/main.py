"""nebari-apps-api: REST API over App custom resources.

Every write renders an App CR; the apps-operator does the actual work. The
UI and (later) the MCP server are thin clients over this API.
"""

import json
import time
from collections import Counter
from collections.abc import Callable
from typing import Annotated, Any

import httpx
import structlog
from fastapi import Body, Depends, FastAPI, File, Form, HTTPException, Query, UploadFile
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse, Response
from pydantic import ValidationError

from . import __version__
from . import cr as crmod
from .auth import User, app_managers, app_role, can_access, can_change_managers, current_user, is_admin
from .config import settings
from .groups import group_path
from .images import check_image, parse_allowlist
from .k8s import READY_TIMEOUT, AppStore, ConflictError, KubernetesAppStore, NotFoundError
from .limits import BodySizeLimitMiddleware
from .logs import RequestIdMiddleware, configure_logging
from .metrics import METRICS_PATH, MetricsMiddleware, metrics_response
from .models import (
    IMAGE_RESERVED_PORTS,
    MAX_SECRET_KEYS,
    SOURCE_TYPES,
    AnalyticsSummary,
    AppCreate,
    AppMetrics,
    AppOut,
    AppPatch,
    AppSource,
    AppUsage,
    Capabilities,
    ClusterMetrics,
    NamespaceUsage,
    PodMetric,
    SecretKey,
)
from .upload import PIXI_MANIFESTS, files_from_upload, read_capped

PREFIX = "/api/v1"
# A JWKS fetch that succeeded is trusted this long before readyz fetches again,
# so probes don't hammer Keycloak.
JWKS_READY_TTL = 60.0
# Total size of the secret values one request may set. A Secret holds at most
# 1 MiB (base64 adds a third), and secrets are for credentials, not files.
MAX_SECRET_BYTES = 256 * 1024

log = structlog.get_logger("nebari_apps_api")


def create_app(store: AppStore | None = None) -> FastAPI:
    app = FastAPI(title="nebari-apps-api", version=__version__)
    # Fail at startup on a malformed allowlist entry, as the operator does.
    image_registries = parse_allowlist(settings.image_registries)
    if not settings.auth_enabled:
        log.warning(
            "AUTHENTICATION IS DISABLED (AUTH_ENABLED=false): every request is anonymous and "
            "treated as an admin. Use this for local development only."
        )
    app.add_middleware(BodySizeLimitMiddleware, max_bytes=lambda: settings.max_request_bytes)
    # Added last, so it is outermost: the id is bound before anything else logs.
    app.add_middleware(MetricsMiddleware)
    app.add_middleware(RequestIdMiddleware, quiet_paths=[PREFIX + "/healthz", PREFIX + "/readyz", METRICS_PATH])
    app.state.store = store

    def get_store() -> AppStore:
        if app.state.store is None:
            app.state.store = KubernetesAppStore(settings.allowed_namespaces or None)
        current: AppStore = app.state.store
        return current

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

    def write_secrets(store: AppStore, cr: dict[str, Any], changes: dict[str, str | None]) -> str:
        """Write secret values to the App's own Secret, owned by the App so it
        is deleted with it, and return the Secret's new resourceVersion. The
        values are never logged, stored on the App or returned.
        """
        meta = cr.get("metadata") or {}
        namespace, name, uid = meta.get("namespace", ""), meta.get("name", ""), meta.get("uid", "")
        owner = {"apiVersion": crmod.API_VERSION, "kind": "App", "name": name, "uid": uid}
        labels = {"app.kubernetes.io/managed-by": "apps-api", "apps.nebari.dev/app": name}
        try:
            if not uid:
                raise ValueError("the App has no uid")
            return store.write_secret(namespace, crmod.secret_name(name), owner, labels, changes)
        except Exception as exc:
            # The type only: an apiserver error body is not worth the risk.
            log.error("writing app secret failed", namespace=namespace, app=name, error=type(exc).__name__)
            raise HTTPException(502, f"could not store the secrets of app {namespace}/{name}; try again") from None

    def create_checked(store: AppStore, user: User, req: AppCreate) -> AppOut:
        _validate_request(req)
        _check_image(req.source, req.runtime.pixiTask, image_registries)
        check_namespace(store, req.namespace)
        # Subdomains are unique across every App in the cluster; the operator
        # enforces the same rule, this just refuses before the CR exists.
        sub = req.access.subdomain
        for cr in store.list_apps(None):
            meta = cr.get("metadata") or {}
            if ((cr.get("spec") or {}).get("access") or {}).get("subdomain") == sub and not (
                meta.get("namespace") == req.namespace and meta.get("name") == req.name
            ):
                raise HTTPException(409, f"subdomain {sub!r} is already used by another app")
        try:
            created = store.create_app(req.namespace, crmod.to_cr(req, user.username))
        except ConflictError:
            raise HTTPException(409, f"app {req.namespace}/{req.name} already exists") from None
        if req.secrets:
            # The Secret's owner reference needs the App's uid, so it is
            # written second; until it exists the pod waits for it (the
            # kubelet retries) rather than starting without its credentials.
            try:
                write_secrets(store, created, dict(req.secrets))
            except HTTPException:
                # Do not leave an App behind that can never start.
                try:
                    store.delete_app(req.namespace, req.name)
                except Exception as exc:
                    log.error("rolling back app failed", app=req.name, error=type(exc).__name__)
                raise
        return crmod.from_cr(created, app_role(user, created))

    def authorized_app(store: AppStore, user: User, namespace: str, name: str) -> dict[str, Any]:
        """Fetch an App the caller may act on: the path namespace must be a
        launchable namespace and the caller must own or manage the App (see
        auth.is_manager) or be an admin.
        Every route that addresses one App goes through here.
        """
        check_namespace(store, namespace)
        cr = must_get(store, namespace, name)
        if not can_access(user, cr):
            raise HTTPException(403, f"you do not have access to app {namespace}/{name}")
        return cr

    def update_app(
        store: AppStore,
        user: User,
        namespace: str,
        name: str,
        change: Callable[[dict[str, Any]], dict[str, Any]],
    ) -> dict[str, Any]:
        """Read-modify-write an App. The write carries the read's resourceVersion,
        so a concurrent edit (UI, MCP, kubectl) makes it conflict: re-read, which
        also re-checks access, and apply the change once more. A second conflict
        is the caller's to retry (409).
        """
        for attempt in range(2):
            existing = authorized_app(store, user, namespace, name)
            try:
                return store.replace_app(namespace, name, change(existing))
            except ConflictError:
                if attempt:
                    raise HTTPException(
                        409, f"app {namespace}/{name} was changed by someone else; reload and try again"
                    ) from None
        raise AssertionError("unreachable")

    def visible_apps(store: AppStore, user: User, namespace: str | None) -> list[dict[str, Any]]:
        """Apps the caller may see: launchable namespaces only, filtered to
        the ones they own or manage unless the caller is an admin.
        """
        if namespace is not None:
            check_namespace(store, namespace)
        allowed = launchable_namespaces(store)
        return [
            cr
            for cr in store.list_apps(namespace)
            if (cr.get("metadata") or {}).get("namespace") in allowed and can_access(user, cr)
        ]

    # ------------------------------------------------------------------ meta
    @app.get(METRICS_PATH, include_in_schema=False)
    def prometheus_metrics() -> Response:
        return metrics_response()

    @app.get(PREFIX + "/healthz", include_in_schema=False)
    def healthz() -> dict[str, str]:
        return {"status": "ok"}

    jwks_ok_until = 0.0

    def check_jwks() -> None:
        nonlocal jwks_ok_until
        if time.monotonic() < jwks_ok_until:
            return
        resp = httpx.get(settings.jwks_url, timeout=READY_TIMEOUT)
        resp.raise_for_status()
        if not resp.json().get("keys"):
            raise ValueError("JWKS has no keys")
        jwks_ok_until = time.monotonic() + JWKS_READY_TTL

    @app.get(PREFIX + "/readyz", include_in_schema=False)
    def readyz(store: Store) -> JSONResponse:
        """Ready when the Kubernetes API answers and, with auth on, the realm JWKS loads.

        The response names failing checks but not why: it is reachable without
        a token. The reason is logged.
        """
        checks: dict[str, str] = {}
        probes = [("kubernetes", store.check_ready)]
        if settings.auth_enabled:
            probes.append(("jwks", check_jwks))
        for name, probe in probes:
            try:
                probe()
                checks[name] = "ok"
            except Exception as exc:
                log.warning("readiness check failed", check=name, error=str(exc))
                checks[name] = "failed"
        ready = all(v == "ok" for v in checks.values())
        return JSONResponse({"status": "ok" if ready else "unavailable", "checks": checks}, 200 if ready else 503)

    @app.get(PREFIX + "/version")
    def version() -> dict[str, str]:
        """Public: which release and image this API is, for bug reports."""
        return {"version": __version__, "build": settings.build}

    @app.get(PREFIX + "/config")
    def ui_config() -> dict[str, Any]:
        """Public bootstrap config for the UI (keycloak-js)."""
        return {
            "version": __version__,
            "build": settings.build,
            "authEnabled": settings.auth_enabled,
            "keycloak": {
                "url": settings.ui_keycloak_url,
                "realm": settings.ui_keycloak_realm,
                "clientId": settings.ui_keycloak_client_id,
            },
            "appsDomain": settings.apps_domain,
            "appsScheme": "http" if settings.tls_disabled else "https",
            # Empty clientId: no MCP OAuth client is configured.
            "mcpOAuth": {
                "clientId": settings.mcp_oauth_client_id,
                "callbackPort": settings.mcp_oauth_callback_port,
            },
        }

    @app.get(PREFIX + "/capabilities", response_model=Capabilities)
    def capabilities(store: Store, user: Me) -> Capabilities:
        return Capabilities(
            appsDomain=settings.apps_domain,
            sourceTypes=[t for t in SOURCE_TYPES if t != "image" or image_registries],
            namespaces=launchable_namespaces(store),
            idleTimeoutMinutes=settings.idle_timeout_minutes,
            imageRegistries=image_registries,
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
        return [crmod.from_cr(item, app_role(user, item)) for item in visible_apps(store, user, namespace)]

    @app.post(PREFIX + "/apps", response_model=AppOut, status_code=201)
    def create(req: AppCreate, store: Store, user: Me) -> AppOut:
        return create_checked(store, user, req)

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
        try:
            req = AppCreate.model_validate(data)
        except ValidationError as exc:
            # A 422 like a JSON body gets, not a 500.
            raise RequestValidationError(exc.errors()) from exc

        return create_checked(store, user, req)

    @app.get(PREFIX + "/apps/{namespace}/{name}", response_model=AppOut)
    def get_app(namespace: str, name: str, store: Store, user: Me) -> AppOut:
        cr = authorized_app(store, user, namespace, name)
        return crmod.from_cr(cr, app_role(user, cr))

    def patch_checked(store: AppStore, user: User, namespace: str, name: str, patch: AppPatch) -> AppOut:
        _check_access(patch.access)
        _check_source(patch.source)
        if patch.secrets:
            _check_secret_values(patch.secrets)
        # The Secret is written once, before the first attempt to update the
        # App; a retry after a conflict reuses its version.
        written: list[str] = []

        def change(existing: dict[str, Any]) -> dict[str, Any]:
            current = ((existing.get("spec") or {}).get("access") or {}).get("subdomain")
            if patch.access is not None and current and patch.access.subdomain != current:
                raise HTTPException(422, "access.subdomain cannot be changed after launch")
            if (
                patch.access is not None
                and "managers" in patch.access.model_fields_set
                and not can_change_managers(user, existing)
            ):
                sent = patch.access.managers.model_dump() if patch.access.managers else {}
                wanted = {key: list(sent.get(key) or []) for key in ("users", "groups")}
                if wanted != app_managers(existing):
                    raise HTTPException(403, "only the owner or an admin can change who manages this app")
            cr = crmod.apply_patch(existing, patch)
            if patch.source is not None or patch.runtime is not None:
                spec = cr.get("spec") or {}
                if (spec.get("source") or {}).get("type") == "image":
                    stored = AppSource.model_validate(spec["source"])
                    _check_image(stored, str((spec.get("runtime") or {}).get("pixiTask") or ""), image_registries)
            if patch.secrets:
                keys = set(crmod.secret_keys(cr))
                keys |= {k for k, v in patch.secrets.items() if v is not None}
                keys -= {k for k, v in patch.secrets.items() if v is None}
                if len(keys) > MAX_SECRET_KEYS:
                    raise HTTPException(422, f"an app may have at most {MAX_SECRET_KEYS} secret keys")
                _check_secret_names(keys, crmod.env_names(cr))
                if not written:
                    written.append(write_secrets(store, cr, dict(patch.secrets)))
                crmod.set_secret_keys(cr, sorted(keys))
                annotations = cr.setdefault("metadata", {}).setdefault("annotations", {})
                annotations[crmod.SECRETS_VERSION_ANNOTATION] = written[0]
            elif patch.runtime is not None:
                _check_secret_names(set(crmod.secret_keys(cr)), crmod.env_names(cr))
            if patch.runtime is not None:
                env = ((cr.get("spec") or {}).get("runtime") or {}).get("env") or []
                if problem := crmod.forbidden_env_ref(name, env):
                    raise HTTPException(422, problem)
            return cr

        cr = update_app(store, user, namespace, name, change)
        return crmod.from_cr(cr, app_role(user, cr))

    @app.patch(PREFIX + "/apps/{namespace}/{name}", response_model=AppOut)
    def patch_app(namespace: str, name: str, patch: AppPatch, store: Store, user: Me) -> AppOut:
        return patch_checked(store, user, namespace, name, patch)

    @app.patch(PREFIX + "/apps/{namespace}/{name}/secrets", response_model=AppOut)
    def patch_secrets(
        namespace: str,
        name: str,
        secrets: Annotated[dict[SecretKey, str | None], Body(max_length=MAX_SECRET_KEYS)],
        store: Store,
        user: Me,
    ) -> AppOut:
        """Set or rotate (a value) or remove (null) the App's secret keys; keys
        not sent are kept. Write-only: the response lists key names
        (runtime.secretKeys), never values. Rolls the app's pods.
        """
        return patch_checked(store, user, namespace, name, AppPatch(secrets=secrets))

    @app.delete(PREFIX + "/apps/{namespace}/{name}", status_code=204)
    def delete_app(namespace: str, name: str, store: Store, user: Me) -> None:
        authorized_app(store, user, namespace, name)
        store.delete_app(namespace, name)

    def _scale(store: AppStore, user: User, namespace: str, name: str, replicas: int) -> AppOut:
        def change(existing: dict[str, Any]) -> dict[str, Any]:
            existing.setdefault("spec", {}).setdefault("runtime", {})["replicas"] = replicas
            return existing

        cr = update_app(store, user, namespace, name, change)
        return crmod.from_cr(cr, app_role(user, cr))

    @app.post(PREFIX + "/apps/{namespace}/{name}/stop", response_model=AppOut)
    def stop_app(namespace: str, name: str, store: Store, user: Me) -> AppOut:
        return _scale(store, user, namespace, name, 0)

    @app.post(PREFIX + "/apps/{namespace}/{name}/start", response_model=AppOut)
    def start_app(namespace: str, name: str, store: Store, user: Me) -> AppOut:
        """Start a stopped app (replicas 0 -> 1) or wake an Idle one: the wake
        annotation counts as a request, so the operator scales it back up.
        """

        def change(existing: dict[str, Any]) -> dict[str, Any]:
            runtime = existing.setdefault("spec", {}).setdefault("runtime", {})
            if runtime.get("replicas", 1) == 0:
                runtime["replicas"] = 1
            annotations = existing.setdefault("metadata", {}).setdefault("annotations", {})
            annotations[crmod.WAKE_ANNOTATION] = crmod.wake_timestamp()
            return existing

        cr = update_app(store, user, namespace, name, change)
        return crmod.from_cr(cr, app_role(user, cr))

    @app.post(PREFIX + "/apps/{namespace}/{name}/restart", response_model=AppOut)
    def restart_app(namespace: str, name: str, store: Store, user: Me) -> AppOut:
        cr = authorized_app(store, user, namespace, name)
        if ((cr.get("spec") or {}).get("runtime") or {}).get("replicas", 1) == 0:
            raise HTTPException(409, f"app {namespace}/{name} is stopped; start it instead")
        try:
            store.restart_app(namespace, name)
        except NotFoundError as exc:
            raise HTTPException(409, f"app {namespace}/{name} is not running") from exc
        fresh = must_get(store, namespace, name)
        return crmod.from_cr(fresh, app_role(user, fresh))

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
        """Per-pod usage (metrics.k8s.io) joined with health from the pods.

        available=false means no metrics server: cpu/memory are then "", but
        restarts, lastTermination, startedAt, limits and requests still come
        back, from pod status and spec.
        """
        authorized_app(store, user, namespace, name)
        pods = {p["name"]: p for p in store.pod_health(namespace, name)}
        try:
            usage = store.pod_metrics(namespace, name)
            available = True
        except NotFoundError:
            usage, available = [], False
        for u in usage:
            # Usage for a pod the list no longer has (it just finished or
            # went away) is dropped: the pod list is the set of live pods.
            if u["name"] in pods:
                pods[u["name"]].update(cpu=u["cpu"], memory=u["memory"])
        return AppMetrics(available=available, pods=[PodMetric.model_validate(p) for p in pods.values()])

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
        by_namespace = [NamespaceUsage(namespace=ns, cpu=v["cpu"], memory=v["memory"]) for ns, v in ns_agg.items()]
        by_namespace.sort(key=lambda n: (n.cpu, n.memory), reverse=True)

        return ClusterMetrics(usageAvailable=usage_available, apps=apps, byNamespace=by_namespace)

    return app


def _check_access(access: Any) -> None:
    """Each group entry must name a Keycloak group. nebari-operator matches
    entries as full group paths ("finance" is "/finance") and denies every
    request when all of an App's entries name nothing (such as "/"); the
    apps-operator refuses such an App, and this says so up front.
    """
    if access is None:
        return
    for entry in access.groups:
        if not group_path(entry):
            raise HTTPException(422, "access.groups: entries must name a group, such as finance or /parent/child")
    if access.managers is not None:
        if any(not entry.strip() for entry in access.managers.users):
            raise HTTPException(422, "access.managers.users: entries must be non-empty")
        if any(not group_path(entry) for entry in access.managers.groups):
            raise HTTPException(
                422, "access.managers.groups: entries must name a group, such as finance or /parent/child"
            )


def _check_source(source: Any) -> None:
    if source is not None and source.inline is not None:
        # The same cap as uploads: inline files become one ConfigMap, which
        # the apiserver refuses past ~1 MiB.
        size = sum(len(c.encode()) for c in source.inline.files.values())
        if size > settings.max_upload_bytes:
            raise HTTPException(
                413,
                f"inline files total {size} bytes, over the {settings.max_upload_bytes}-byte cap; "
                "use a git or pvc source for larger apps",
            )
    if source is not None and source.type == "git" and source.git is not None:
        try:
            source.git.check()
        except ValueError as exc:
            raise HTTPException(422, f"source.git: {exc}") from None


def _check_image(source: Any, pixi_task: str, allowlist: list[str]) -> None:
    """An image source must match the registry allowlist (the operator checks
    it again for every App), leave the sidecar's ports free and not ask for a
    pixi task.
    """
    if source is None or source.type != "image":
        return
    if source.image is None:
        raise HTTPException(422, "source.image is required for source type 'image'")
    if pixi_task:
        raise HTTPException(
            422, "runtime.pixiTask cannot be combined with source type image: the image runs its own server"
        )
    if source.image.port in IMAGE_RESERVED_PORTS:
        raise HTTPException(
            422,
            f"source.image.port may not be {' or '.join(map(str, IMAGE_RESERVED_PORTS))}: the apps-authz sidecar uses them",
        )
    try:
        check_image(source.image.reference, allowlist)
    except ValueError as exc:
        raise HTTPException(422, f"source.image.reference: {exc}") from None


def _check_secret_values(secrets: dict[str, str | None]) -> None:
    size = sum(len(v.encode()) for v in secrets.values() if v is not None)
    if size > MAX_SECRET_BYTES:
        raise HTTPException(413, f"secret values total {size} bytes, over the {MAX_SECRET_BYTES}-byte cap")


def _check_secret_names(keys: set[str], env: set[str]) -> None:
    """A secret key and a plain env var of the same name would race for one
    variable; refuse it rather than pick a winner silently.
    """
    clash = sorted(keys & env)
    if clash:
        raise HTTPException(422, f"{', '.join(clash)}: set as both a secret and a plain environment variable; keep one")


def _validate_request(req: AppCreate) -> None:
    _check_access(req.access)
    _check_source(req.source)
    _check_secret_values(dict(req.secrets))
    _check_secret_names(set(req.secrets), {e.name for e in req.runtime.env})
    if problem := crmod.forbidden_env_ref(req.name, [e.model_dump() for e in req.runtime.env]):
        raise HTTPException(422, problem)
    if getattr(req.source, req.source.type, None) is None:
        raise HTTPException(422, f"source.{req.source.type} is required for source type {req.source.type!r}")
    if req.runtime.pixiTask and req.source.type == "inline":
        files = req.source.inline.files if req.source.inline else {}
        if not any(m in files for m in PIXI_MANIFESTS):
            raise HTTPException(422, "pixi apps need a pixi.toml or pyproject.toml at the source root")


configure_logging()
app = create_app()
