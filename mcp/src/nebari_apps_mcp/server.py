"""The MCP server: agent-facing tools over apps-api.

Every tool is a thin, well-described wrapper over the REST API so behavior
is identical to the UI. Tools return structured JSON the agent can reason
over; failures surface the API's human-readable detail.
"""

from __future__ import annotations

import time
from typing import TYPE_CHECKING, Annotated, Any, Literal, cast

import structlog
from fastmcp import Context, FastMCP
from fastmcp.exceptions import ToolError
from fastmcp.server.dependencies import get_http_headers
from fastmcp.server.middleware import Middleware, MiddlewareContext
from pydantic import Field
from starlette.middleware import Middleware as ASGIMiddleware
from starlette.requests import Request
from starlette.responses import JSONResponse, Response

from . import __version__
from .auth import MissingSessionError, TokenVerificationError, auth, get_validator
from .client import ApiClient, ApiError
from .config import settings
from .logs import REQUEST_ID_HEADER, RequestIdMiddleware, configure_logging
from .untrusted import fence_app, fence_logs, summarize_app

if TYPE_CHECKING:
    import mcp_types as mt
    from fastmcp.server.middleware import CallNext
    from fastmcp.tools.base import ToolResult

mcp = FastMCP(
    name="nebari-apps",
    version=__version__,
    instructions=(
        "Launch and manage web apps on this Nebari cluster: static sites (HTML/CSS/JS) "
        "and Python apps launched by a pixi task (pixi_task; the task must serve on "
        "0.0.0.0:$PORT), and, where the cluster allows it, prebuilt container images "
        "(source_type=image, from the registries describe_cluster lists). "
        "Typical flow: describe_cluster to see what is available, then launch_app; "
        "poll get_app_status until phase is Running and share the app URL with the user. "
        "If a tool reports an authentication problem, call authenticate and follow its "
        "instructions."
    ),
)

log = structlog.get_logger("nebari_apps_mcp")


@mcp.custom_route("/healthz", methods=["GET"], include_in_schema=False)
async def healthz(request: Request) -> Response:
    return JSONResponse({"status": "ok"})


def _request_id() -> str:
    return get_http_headers().get(REQUEST_ID_HEADER, "")


def _passthrough() -> str:
    """The caller's Authorization header, for bearer passthrough.

    get_http_headers() drops credential headers unless they are asked for by
    name, so a plain .get("authorization") is always empty.
    """
    return get_http_headers(include={"authorization"}).get("authorization", "")


# Tools whose arguments can carry secret values (`secrets`).
SECRET_TOOLS = frozenset({"launch_app", "update_app"})


class ToolLogMiddleware(Middleware):
    """One log line per tool call, carrying the HTTP request's id.

    Tools run in the MCP session's task, not the request's, so the id that
    RequestIdMiddleware bound there is re-bound here from the request headers.
    """

    async def on_call_tool(
        self,
        context: MiddlewareContext[mt.CallToolRequestParams],
        call_next: CallNext[mt.CallToolRequestParams, ToolResult],
    ) -> ToolResult:
        start = time.perf_counter()
        with structlog.contextvars.bound_contextvars(request_id=_request_id(), tool=context.message.name):
            try:
                result = await call_next(context)
            except Exception as exc:
                # An argument validation error quotes the input, which for these
                # tools can be a secret value: log only the error's type.
                error = type(exc).__name__ if context.message.name in SECRET_TOOLS else str(exc)
                log.info("tool call", outcome="error", error=error, duration_ms=_ms(start))
                raise
            log.info("tool call", outcome="ok", duration_ms=_ms(start))
            return result


def _ms(start: float) -> float:
    return round((time.perf_counter() - start) * 1000, 1)


class TokenVerificationMiddleware(Middleware):
    """Reject unverified callers before any tool logic runs.

    Every tool except `authenticate` (the device-flow bootstrap) requires a
    JWT whose signature, issuer, and expiry verify against the realm JWKS -
    whether it arrived as an Authorization header or from this session's
    device-flow login. apps-api verifies again downstream; this layer just
    refuses to proxy for anonymous or forged callers at all.
    """

    async def on_call_tool(
        self,
        context: MiddlewareContext[mt.CallToolRequestParams],
        call_next: CallNext[mt.CallToolRequestParams, ToolResult],
    ) -> ToolResult:
        if not settings.auth_enabled or context.message.name == "authenticate":
            return await call_next(context)

        session_id = ""
        if context.fastmcp_context is not None:
            session_id = context.fastmcp_context.session_id or ""
        passthrough = _passthrough()
        try:
            bearer = await auth.bearer(session_id, passthrough)
        except MissingSessionError as exc:
            raise ToolError(str(exc)) from exc
        if not bearer:
            raise ToolError("not authenticated: call the authenticate tool and follow its instructions")
        token = bearer.removeprefix("Bearer ").strip()
        try:
            get_validator().validate(token)
        except TokenVerificationError as exc:
            raise ToolError(f"token rejected ({exc}): call the authenticate tool to log in again") from exc
        return await call_next(context)


mcp.add_middleware(ToolLogMiddleware())
mcp.add_middleware(TokenVerificationMiddleware())


def _session_id(ctx: Context) -> str:
    return ctx.session_id or ""


async def _api(ctx: Context) -> ApiClient:
    passthrough = _passthrough()
    bearer = await auth.bearer(_session_id(ctx), passthrough)
    return ApiClient(bearer, request_id=_request_id())


# Hints for clients that auto-approve tools: these only read.
READ_ONLY: dict[str, Any] = {"readOnlyHint": True, "openWorldHint": False}


def _error(exc: ApiError) -> dict[str, Any]:
    out: dict[str, Any] = {"error": exc.detail, "status": exc.status}
    if exc.status == 401:
        out["nextAction"] = "call the authenticate tool and follow its instructions"
    return out


@mcp.tool(annotations={"readOnlyHint": False, "destructiveHint": False, "idempotentHint": True, "openWorldHint": False})
async def authenticate(ctx: Context) -> dict[str, Any]:
    """Log in to the cluster via the Keycloak device flow, or confirm the cached login.

    Call this when another tool returns a 401. If the result is
    'action_required', show the user the verificationUrl and userCode, wait for
    them to approve in a browser, then call authenticate again to complete.
    """
    return await auth.authenticate(_session_id(ctx))


@mcp.tool(annotations=READ_ONLY)
async def describe_cluster(ctx: Context) -> dict[str, Any]:
    """Describe what this cluster supports: available source types, namespaces apps may be
    launched into, the apps domain (apps get https://<subdomain>.<appsDomain>) and, when
    sourceTypes includes image, the imageRegistries images may come from.
    Call this first to pick valid launch options.
    """
    try:
        async with await _api(ctx) as api:
            return cast("dict[str, Any]", await api.get("/capabilities"))
    except ApiError as exc:
        return _error(exc)


@mcp.tool(annotations=READ_ONLY)
async def list_apps(
    ctx: Context,
    namespace: Annotated[str, Field(description="Filter to one namespace; empty = all visible namespaces")] = "",
) -> Any:
    """List launched apps with their source type, phase (Pending|Deploying|Running|Failed|Stopped|Idle),
    URL, owner, managers (access.managers) and role (your relationship: owner, manager or admin).
    Lists the apps you own or manage (every app for admins). Idle = scaled to zero after its idle timeout; the next visit to its URL
    (or start_app) wakes it.
    """
    try:
        async with await _api(ctx) as api:
            apps = await api.get("/apps", params={"namespace": namespace} if namespace else None)
            return [summarize_app(a) for a in apps]
    except ApiError as exc:
        return _error(exc)


@mcp.tool(annotations={"readOnlyHint": False, "destructiveHint": True, "idempotentHint": True, "openWorldHint": False})
async def launch_app(
    ctx: Context,
    name: Annotated[str, Field(description="Kubernetes name: lowercase letters, digits, hyphens")],
    namespace: Annotated[str, Field(description="Target namespace (must appear in describe_cluster namespaces)")],
    display_name: Annotated[str, Field(description="Human-readable name shown in the UI and landing page")],
    subdomain: Annotated[str, Field(description="App URL becomes https://<subdomain>.<appsDomain>")],
    source_type: Annotated[
        Literal["inline", "git", "pvc", "image"],
        Field(
            description=(
                "inline = files in the request; git = clone a repo; pvc = mount an existing volume; "
                "image = run a prebuilt container image (only when describe_cluster lists it in sourceTypes; "
                "the image must come from one of its imageRegistries)"
            )
        ),
    ],
    inline_files: Annotated[
        dict[str, str] | None,
        Field(
            description="source_type=inline: relative path -> file content; text files only, ~900KB total. Static apps must include index.html; pixi apps (pixi_task set) must include pixi.toml or pyproject.toml"
        ),
    ] = None,
    git_url: Annotated[
        str,
        Field(
            description="source_type=git: public https:// repository URL (no credentials, no cluster-internal hosts)"
        ),
    ] = "",
    git_ref: Annotated[str, Field(description="source_type=git: branch, tag, or commit")] = "main",
    git_subdir: Annotated[str, Field(description="source_type=git: path of the content root within the repo")] = "",
    pvc_claim_name: Annotated[str, Field(description="source_type=pvc: existing PersistentVolumeClaim name")] = "",
    pvc_sub_path: Annotated[str, Field(description="source_type=pvc: sub-path within the volume")] = "",
    image_reference: Annotated[
        str,
        Field(
            description=(
                "source_type=image: image with a tag or digest, e.g. ghcr.io/org/app:1.2.3 or "
                "ghcr.io/org/app@sha256:<digest>, from a registry in describe_cluster imageRegistries. "
                "Never build images: the user brings a published one"
            )
        ),
    ] = "",
    image_port: Annotated[
        int | None,
        Field(
            description=(
                "source_type=image (required): port the image's server listens on, 1024-65535, not 8080 or "
                "8082 (the auth sidecar's); also passed as $PORT"
            ),
            ge=1024,
            le=65535,
        ),
    ] = None,
    image_command: Annotated[
        list[str] | None,
        Field(description="source_type=image: replaces the image ENTRYPOINT (exec form, no shell)"),
    ] = None,
    image_args: Annotated[
        list[str] | None,
        Field(description="source_type=image: replaces the image CMD (exec form, no shell)"),
    ] = None,
    image_run_as_user: Annotated[
        int | None,
        Field(
            description=(
                "source_type=image: non-zero uid to run as, for images whose USER is a name. Images that only "
                "run as root are refused (phase Failed, reason ImageRunsAsRoot)"
            ),
            ge=1,
        ),
    ] = None,
    env: Annotated[
        dict[str, str] | None,
        Field(
            description="Plain environment variables for the app process. Their values are stored in the app and shown to anyone who can read it: never put credentials here, use secrets"
        ),
    ] = None,
    secrets: Annotated[
        dict[str, str] | None,
        Field(
            description=(
                "Credentials (API keys, tokens, database URLs) as NAME -> value, injected as environment "
                "variables from the app's own Kubernetes Secret. Write-only: no tool ever returns the values, "
                "only the names (runtime.secretKeys). Names must be valid env var names. Prefer asking the user "
                "to enter values in the apps UI (edit the app, Secrets section) over passing them through "
                "this conversation; never read them from files the user did not point you at"
            )
        ),
    ] = None,
    replicas: Annotated[int, Field(description="Desired replicas; 0 = stopped", ge=0, le=10)] = 1,
    resources: Annotated[
        dict[str, dict[str, str]] | None,
        Field(
            description=(
                'CPU/memory requests and limits, e.g. {"requests": {"cpu": "250m", "memory": "512Mi"}, '
                '"limits": {"memory": "1Gi"}}. Anything omitted gets the cluster default '
                "(static apps are small; pixi apps get more memory for pixi install)"
            )
        ),
    ] = None,
    public: Annotated[bool, Field(description="true = anonymous access; false = Keycloak SSO at the gateway")] = False,
    groups: Annotated[
        list[str] | None,
        Field(
            description=(
                "Keycloak groups allowed to open the app (private apps; enforced in the app pod, "
                "everyone else gets 403). Empty, with no users = any signed-in user"
            )
        ),
    ] = None,
    users: Annotated[
        list[str] | None,
        Field(
            description=(
                "Keycloak usernames allowed to open the app, in addition to groups "
                "(a listed user OR a member of a listed group gets in)"
            )
        ),
    ] = None,
    manager_users: Annotated[
        list[str] | None,
        Field(
            description=(
                "Keycloak usernames who may manage the app like you (edit, start, stop, restart, delete, "
                "read logs) but not change its managers. Does not let them open a restricted app. "
                "Omit to keep the current list when re-launching; [] clears it"
            )
        ),
    ] = None,
    manager_groups: Annotated[
        list[str] | None,
        Field(
            description=(
                "Keycloak groups whose members may manage the app, like manager_users. "
                "Omit to keep the current list when re-launching; [] clears it"
            )
        ),
    ] = None,
    description: Annotated[str, Field(description="Short description for catalogs")] = "",
    pixi_task: Annotated[
        str,
        Field(
            description="Run the app as a Python/pixi service: the pixi task to execute (e.g. 'start'). The task must start a server on 0.0.0.0:$PORT (the operator sets it: 8080, or 8081 when the sidecar fronts the app). Empty = static app served by nginx"
        ),
    ] = "",
    landing_page: Annotated[
        bool | None,
        Field(
            description="Show the app as a tile on the Nebari landing page. Omit to use the cluster default (off unless the operator enables it); the app is reachable at its URL either way"
        ),
    ] = None,
    keep_alive: Annotated[
        bool,
        Field(
            description="true = never scale the app to zero when idle (for apps that must answer at once or do background work)"
        ),
    ] = False,
    idle_timeout_minutes: Annotated[
        int | None,
        Field(
            description="Scale the app to zero after this many minutes without a request (phase Idle); the next visit wakes it. Omit for the cluster default (describe_cluster idleTimeoutMinutes; 0 = apps stay up). Ignored with keep_alive",
            ge=5,
            le=43200,
        ),
    ] = None,
) -> dict[str, Any]:
    """Create and launch an app: static (HTML/CSS/JS served by nginx), with pixi_task set
    a Python/pixi service whose source includes a pixi manifest, or with source_type=image a
    prebuilt container image (image_reference + image_port). Idempotent on
    (namespace, name): if the app already exists and you own or manage it, its spec is updated
    instead of failing, so retrying is safe; an app you neither own nor manage is never touched.
    Only the owner (or an admin) may change manager_users/manager_groups. Returns the app with its (pending) URL; poll get_app_status until
    phase=Running.
    """
    source: dict[str, Any] = {"type": source_type}
    if source_type == "inline":
        source["inline"] = {"files": inline_files or {}}
    elif source_type == "git":
        source["git"] = {"url": git_url, "ref": git_ref, "subdir": git_subdir}
    elif source_type == "pvc":
        source["pvc"] = {"claimName": pvc_claim_name, "subPath": pvc_sub_path}
    elif source_type == "image":
        image: dict[str, Any] = {"reference": image_reference, "port": image_port}
        if image_command:
            image["command"] = image_command
        if image_args:
            image["args"] = image_args
        if image_run_as_user is not None:
            image["runAsUser"] = image_run_as_user
        source["image"] = image

    access: dict[str, Any] = {"public": public, "groups": groups or [], "users": users or [], "subdomain": subdomain}
    if manager_users is not None or manager_groups is not None:
        access["managers"] = {"users": manager_users or [], "groups": manager_groups or []}
    body = {
        "name": name,
        "namespace": namespace,
        "displayName": display_name,
        "description": description,
        "source": source,
        "runtime": {
            "replicas": replicas,
            "env": [{"name": k, "value": v} for k, v in (env or {}).items()],
            "pixiTask": pixi_task,
            **({"resources": resources} if resources else {}),
            **({"keepAlive": True} if keep_alive else {}),
            **({"idleTimeoutMinutes": idle_timeout_minutes} if idle_timeout_minutes is not None else {}),
        },
        "access": access,
    }
    if landing_page is not None:
        body["landingPage"] = {"enabled": landing_page}
    if secrets:
        body["secrets"] = secrets
    try:
        async with await _api(ctx) as api:
            try:
                return cast("dict[str, Any]", await api.post("/apps", json=body))
            except ApiError as exc:
                # 409 is either "name exists" (upsert below) or "subdomain
                # taken by another app" (report it as is).
                if exc.status != 409 or "subdomain" in str(exc.detail):
                    raise
                # Already exists: update in place (idempotent launch). The API
                # refuses with 403 when the existing app belongs to someone else,
                # so a retry never overwrites another user's app.
                patch = {
                    k: body[k]
                    for k in ("displayName", "description", "source", "runtime", "access", "landingPage", "secrets")
                    if k in body
                }
                try:
                    return cast("dict[str, Any]", await api.patch(f"/apps/{namespace}/{name}", json=patch))
                except ApiError as patch_exc:
                    if patch_exc.status != 403 or "manages" in str(patch_exc.detail):
                        raise
                    out = _error(patch_exc)
                    out["error"] = (
                        f"an app named {name!r} already exists in namespace {namespace!r} and belongs to another user"
                    )
                    out["nextAction"] = "choose a different name (and subdomain) and call launch_app again"
                    return out
    except ApiError as exc:
        return _error(exc)


@mcp.tool(annotations=READ_ONLY)
async def get_app(ctx: Context, namespace: str, name: str) -> Any:
    """Full spec and status for one app: source, runtime, access, URL, and conditions."""
    try:
        async with await _api(ctx) as api:
            return fence_app(await api.get(f"/apps/{namespace}/{name}"))
    except ApiError as exc:
        return _error(exc)


@mcp.tool(annotations=READ_ONLY)
async def get_app_status(ctx: Context, namespace: str, name: str) -> Any:
    """Lightweight status poll: phase, URL, replica readiness, conditions, message.
    Poll this after launch_app until phase=Running (typically seconds; image pulls can
    take longer).
    """
    try:
        async with await _api(ctx) as api:
            return await api.get(f"/apps/{namespace}/{name}/status")
    except ApiError as exc:
        return _error(exc)


@mcp.tool(annotations=READ_ONLY)
async def get_app_logs(
    ctx: Context,
    namespace: str,
    name: str,
    lines: Annotated[int, Field(description="How many recent lines", ge=1, le=5000)] = 200,
) -> Any:
    """Recent pod logs for an app - the first place to look when phase=Failed or the app
    misbehaves.
    """
    try:
        async with await _api(ctx) as api:
            resp = await api.get(f"/apps/{namespace}/{name}/logs", params={"lines": lines})
            return fence_logs(str(resp.get("logs", "")))
    except ApiError as exc:
        return _error(exc)


@mcp.tool(annotations={"readOnlyHint": False, "destructiveHint": True, "idempotentHint": True, "openWorldHint": False})
async def update_app(
    ctx: Context,
    namespace: str,
    name: str,
    patch: Annotated[
        dict[str, Any],
        Field(
            description="Fields to change: any of displayName, description, source, runtime, access ({public, groups, users, subdomain, managers: {users, groups}}; send the whole object, an empty list clears it; omit managers to keep them, only the owner or an admin may change them), landingPage ({enabled: bool}; {} = cluster default), secrets ({NAME: value} sets or rotates a credential injected from the app's Secret, {NAME: null} removes it, names not sent are kept; write-only, never returned; never put credentials in runtime.env)"
        ),
    ],
) -> Any:
    """Update an existing app's spec or its secrets. The operator rolls the workload automatically."""
    try:
        async with await _api(ctx) as api:
            return fence_app(await api.patch(f"/apps/{namespace}/{name}", json=patch))
    except ApiError as exc:
        return _error(exc)


@mcp.tool(annotations={"readOnlyHint": False, "destructiveHint": True, "idempotentHint": True, "openWorldHint": False})
async def stop_app(ctx: Context, namespace: str, name: str) -> Any:
    """Scale an app to zero replicas (phase becomes Stopped). Routing and configuration
    are kept; start_app brings it back.
    """
    try:
        async with await _api(ctx) as api:
            return fence_app(await api.post(f"/apps/{namespace}/{name}/stop"))
    except ApiError as exc:
        return _error(exc)


@mcp.tool(annotations={"readOnlyHint": False, "destructiveHint": False, "idempotentHint": True, "openWorldHint": False})
async def start_app(ctx: Context, namespace: str, name: str) -> Any:
    """Scale a stopped app back up to one replica, or wake an Idle app (it keeps its replicas)."""
    try:
        async with await _api(ctx) as api:
            return fence_app(await api.post(f"/apps/{namespace}/{name}/start"))
    except ApiError as exc:
        return _error(exc)


@mcp.tool(
    annotations={"readOnlyHint": False, "destructiveHint": False, "idempotentHint": False, "openWorldHint": False}
)
async def restart_app(ctx: Context, namespace: str, name: str) -> Any:
    """Roll the app's pods without changing its spec (like `kubectl rollout restart`).
    Use after external content or config changes, or to recover a wedged pod. Fails if the
    app is stopped (start_app first).
    """
    try:
        async with await _api(ctx) as api:
            return fence_app(await api.post(f"/apps/{namespace}/{name}/restart"))
    except ApiError as exc:
        return _error(exc)


@mcp.tool(annotations=READ_ONLY)
async def get_app_metrics(ctx: Context, namespace: str, name: str) -> Any:
    """Instantaneous CPU (millicores) and memory (Mi) usage per pod, from metrics.k8s.io.
    Returns {available, pods:[{name, cpu, memory}]}; available=false when the cluster has no
    metrics server. Use to judge whether an app needs more replicas or resources.
    """
    try:
        async with await _api(ctx) as api:
            return await api.get(f"/apps/{namespace}/{name}/metrics")
    except ApiError as exc:
        return _error(exc)


@mcp.tool(annotations={"readOnlyHint": False, "destructiveHint": True, "idempotentHint": True, "openWorldHint": False})
async def remove_app(
    ctx: Context,
    namespace: str,
    name: str,
    confirm: Annotated[
        bool, Field(description="Must be true: set it only after the user has agreed to delete this app")
    ] = False,
) -> dict[str, Any]:
    """Delete an app permanently. Cascades: workload, routing, TLS certificate, and OIDC
    client are all removed. There is no undo - ask the user first, then call with confirm=true.
    """
    if not confirm:
        raise ToolError(
            f"remove_app deletes {namespace}/{name} permanently; ask the user to confirm, then call again with confirm=true"
        )
    try:
        async with await _api(ctx) as api:
            await api.delete(f"/apps/{namespace}/{name}")
            return {"deleted": f"{namespace}/{name}"}
    except ApiError as exc:
        return _error(exc)


def main() -> None:
    configure_logging()
    if not settings.auth_enabled:
        log.warning(
            "AUTHENTICATION IS DISABLED (AUTH_ENABLED=false): every tool call is anonymous. "
            "Use this for local development only."
        )
    mcp.run(
        transport="http",
        host=settings.host,
        port=settings.port,
        show_banner=False,
        middleware=[ASGIMiddleware(RequestIdMiddleware, quiet_paths=["/healthz"])],
        # Keep the logging configure_logging set up; RequestIdMiddleware writes the access lines.
        uvicorn_config={"log_config": None, "access_log": False},
    )


if __name__ == "__main__":
    main()
