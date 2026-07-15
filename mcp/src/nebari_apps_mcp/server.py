"""The MCP server: agent-facing tools over apps-api.

Every tool is a thin, well-described wrapper over the REST API so behavior
is identical to the UI. Tools return structured JSON the agent can reason
over; failures surface the API's human-readable detail.
"""

from __future__ import annotations

from typing import Annotated, Any, Literal

from fastmcp import Context, FastMCP
from fastmcp.exceptions import ToolError
from fastmcp.server.dependencies import get_http_headers
from fastmcp.server.middleware import Middleware, MiddlewareContext
from pydantic import Field

from .auth import TokenVerificationError, auth, get_validator
from .client import ApiClient, ApiError
from .config import settings

mcp = FastMCP(
    name="nebari-apps",
    instructions=(
        "Launch and manage web applications (static sites and Python apps) on this Nebari "
        "cluster. Typical flow: describe_cluster to see what is available, then launch_app; "
        "poll get_app_status until phase is Running and share the app URL with the user. "
        "If a tool reports an authentication problem, call authenticate and follow its "
        "instructions."
    ),
)


class TokenVerificationMiddleware(Middleware):
    """Reject unverified callers before any tool logic runs.

    Every tool except `authenticate` (the device-flow bootstrap) requires a
    JWT whose signature, issuer, and expiry verify against the realm JWKS -
    whether it arrived as an Authorization header or from this session's
    device-flow login. apps-api verifies again downstream; this layer just
    refuses to proxy for anonymous or forged callers at all.
    """

    async def on_call_tool(self, context: MiddlewareContext, call_next):
        if not settings.auth_enabled or context.message.name == "authenticate":
            return await call_next(context)

        session_id = ""
        if context.fastmcp_context is not None:
            session_id = context.fastmcp_context.session_id or ""
        passthrough = get_http_headers().get("authorization", "")
        bearer = await auth.bearer(session_id, passthrough)
        if not bearer:
            raise ToolError(
                "not authenticated: call the authenticate tool and follow its instructions"
            )
        token = bearer.removeprefix("Bearer ").strip()
        try:
            get_validator().validate(token)
        except TokenVerificationError as exc:
            raise ToolError(
                f"token rejected ({exc}): call the authenticate tool to log in again"
            ) from exc
        return await call_next(context)


mcp.add_middleware(TokenVerificationMiddleware())

Framework = Literal["static", "streamlit", "panel", "gradio", "dash", "voila", "fastapi", "custom"]


def _session_id(ctx: Context) -> str:
    return ctx.session_id or "anonymous"


async def _api(ctx: Context) -> ApiClient:
    passthrough = get_http_headers().get("authorization", "")
    bearer = await auth.bearer(_session_id(ctx), passthrough)
    return ApiClient(bearer)


def _error(exc: ApiError) -> dict[str, Any]:
    out: dict[str, Any] = {"error": exc.detail, "status": exc.status}
    if exc.status == 401:
        out["nextAction"] = "call the authenticate tool and follow its instructions"
    return out


@mcp.tool
async def authenticate(ctx: Context) -> dict[str, Any]:
    """Log in to the cluster via the Keycloak device flow, or confirm the cached login.

    Call this when another tool returns a 401. If the result is
    'action_required', show the user the verificationUrl and userCode, wait for
    them to approve in a browser, then call authenticate again to complete.
    """
    return await auth.authenticate(_session_id(ctx))


@mcp.tool
async def describe_cluster(ctx: Context) -> dict[str, Any]:
    """Describe what this cluster supports: available frameworks, namespaces apps may be
    launched into, the apps domain (apps get https://<subdomain>.<appsDomain>), and whether
    Nebi pixi environments are available. Call this first to pick valid launch options."""
    try:
        async with await _api(ctx) as api:
            return await api.get("/capabilities")
    except ApiError as exc:
        return _error(exc)


@mcp.tool
async def list_frameworks(ctx: Context) -> Any:
    """List supported frameworks with their allowed and currently implemented source types.
    Use it to validate a launch before calling launch_app."""
    try:
        async with await _api(ctx) as api:
            return await api.get("/frameworks")
    except ApiError as exc:
        return _error(exc)


@mcp.tool
async def list_environments(ctx: Context) -> Any:
    """List pixi environments (Nebi) available for ociEnv launches. Currently returns an
    empty list on clusters without the Nebi integration."""
    try:
        async with await _api(ctx) as api:
            return await api.get("/environments")
    except ApiError as exc:
        return _error(exc)


@mcp.tool
async def list_apps(
    ctx: Context,
    namespace: Annotated[str, Field(description="Filter to one namespace; empty = all visible namespaces")] = "",
) -> Any:
    """List launched apps with their framework, phase (Pending|Deploying|Running|Failed|Stopped),
    URL, and owner."""
    try:
        async with await _api(ctx) as api:
            return await api.get("/apps", params={"namespace": namespace} if namespace else None)
    except ApiError as exc:
        return _error(exc)


@mcp.tool
async def launch_app(
    ctx: Context,
    name: Annotated[str, Field(description="Kubernetes name: lowercase letters, digits, hyphens")],
    namespace: Annotated[str, Field(description="Target namespace (must appear in describe_cluster namespaces)")],
    display_name: Annotated[str, Field(description="Human-readable name shown in the UI and landing page")],
    framework: Annotated[Framework, Field(description="static for HTML/JS sites; a Python framework or custom for prebuilt images")],
    subdomain: Annotated[str, Field(description="App URL becomes https://<subdomain>.<appsDomain>")],
    source_type: Annotated[
        Literal["inline", "git", "image", "pvc"],
        Field(description="static: inline|git|pvc. Python/custom: image."),
    ],
    inline_files: Annotated[
        dict[str, str] | None,
        Field(description="source_type=inline: relative path -> file content (must include index.html); text files only, ~900KB total"),
    ] = None,
    git_url: Annotated[str, Field(description="source_type=git: HTTPS repository URL")] = "",
    git_ref: Annotated[str, Field(description="source_type=git: branch, tag, or commit")] = "main",
    git_subdir: Annotated[str, Field(description="source_type=git: path of the content root within the repo")] = "",
    image_repository: Annotated[str, Field(description="source_type=image: image listening on port 8080 as non-root")] = "",
    image_tag: Annotated[str, Field(description="source_type=image: tag")] = "latest",
    pvc_claim_name: Annotated[str, Field(description="source_type=pvc: existing PersistentVolumeClaim name")] = "",
    pvc_sub_path: Annotated[str, Field(description="source_type=pvc: sub-path within the volume")] = "",
    command: Annotated[list[str] | None, Field(description="Container command override; required for framework=custom")] = None,
    env: Annotated[dict[str, str] | None, Field(description="Environment variables for the app process")] = None,
    replicas: Annotated[int, Field(description="Desired replicas; 0 = stopped", ge=0, le=10)] = 1,
    public: Annotated[bool, Field(description="true = anonymous access; false = Keycloak SSO at the gateway")] = False,
    groups: Annotated[list[str] | None, Field(description="Keycloak groups allowed to use the app; empty = any signed-in user")] = None,
    description: Annotated[str, Field(description="Short description for catalogs")] = "",
) -> dict[str, Any]:
    """Create and launch an app. Idempotent on (namespace, name): if the app already exists
    its spec is updated instead of failing, so retrying is safe. Returns the app with its
    (pending) URL; poll get_app_status until phase=Running."""
    source: dict[str, Any] = {"type": source_type}
    if source_type == "inline":
        source["inline"] = {"files": inline_files or {}}
    elif source_type == "git":
        source["git"] = {"url": git_url, "ref": git_ref, "subdir": git_subdir}
    elif source_type == "image":
        source["image"] = {"repository": image_repository, "tag": image_tag}
    elif source_type == "pvc":
        source["pvc"] = {"claimName": pvc_claim_name, "subPath": pvc_sub_path}

    body = {
        "name": name,
        "namespace": namespace,
        "displayName": display_name,
        "description": description,
        "framework": framework,
        "source": source,
        "runtime": {
            "replicas": replicas,
            "command": command or [],
            "env": [{"name": k, "value": v} for k, v in (env or {}).items()],
        },
        "access": {"public": public, "groups": groups or [], "subdomain": subdomain},
    }
    try:
        async with await _api(ctx) as api:
            try:
                return await api.post("/apps", json=body)
            except ApiError as exc:
                if exc.status != 409:
                    raise
                # Already exists: update in place (idempotent launch).
                patch = {k: body[k] for k in ("displayName", "description", "source", "runtime", "access")}
                return await api.patch(f"/apps/{namespace}/{name}", json=patch)
    except ApiError as exc:
        return _error(exc)


@mcp.tool
async def get_app(ctx: Context, namespace: str, name: str) -> Any:
    """Full spec and status for one app: source, runtime, access, URL, and conditions."""
    try:
        async with await _api(ctx) as api:
            return await api.get(f"/apps/{namespace}/{name}")
    except ApiError as exc:
        return _error(exc)


@mcp.tool
async def get_app_status(ctx: Context, namespace: str, name: str) -> Any:
    """Lightweight status poll: phase, URL, replica readiness, conditions, message.
    Poll this after launch_app until phase=Running (typically seconds; image pulls can
    take longer)."""
    try:
        async with await _api(ctx) as api:
            return await api.get(f"/apps/{namespace}/{name}/status")
    except ApiError as exc:
        return _error(exc)


@mcp.tool
async def get_app_logs(
    ctx: Context,
    namespace: str,
    name: str,
    lines: Annotated[int, Field(description="How many recent lines", ge=1, le=5000)] = 200,
) -> Any:
    """Recent pod logs for an app - the first place to look when phase=Failed or the app
    misbehaves."""
    try:
        async with await _api(ctx) as api:
            return await api.get(f"/apps/{namespace}/{name}/logs", params={"lines": lines})
    except ApiError as exc:
        return _error(exc)


@mcp.tool
async def update_app(
    ctx: Context,
    namespace: str,
    name: str,
    patch: Annotated[
        dict[str, Any],
        Field(description="Fields to change: any of displayName, description, source, runtime, access (same shapes as launch_app)"),
    ],
) -> Any:
    """Update an existing app's spec. The operator rolls the workload automatically."""
    try:
        async with await _api(ctx) as api:
            return await api.patch(f"/apps/{namespace}/{name}", json=patch)
    except ApiError as exc:
        return _error(exc)


@mcp.tool
async def stop_app(ctx: Context, namespace: str, name: str) -> Any:
    """Scale an app to zero replicas (phase becomes Stopped). Routing and configuration
    are kept; start_app brings it back."""
    try:
        async with await _api(ctx) as api:
            return await api.post(f"/apps/{namespace}/{name}/stop")
    except ApiError as exc:
        return _error(exc)


@mcp.tool
async def start_app(ctx: Context, namespace: str, name: str) -> Any:
    """Scale a stopped app back up to one replica."""
    try:
        async with await _api(ctx) as api:
            return await api.post(f"/apps/{namespace}/{name}/start")
    except ApiError as exc:
        return _error(exc)


@mcp.tool
async def remove_app(ctx: Context, namespace: str, name: str) -> dict[str, Any]:
    """Delete an app permanently. Cascades: workload, routing, TLS certificate, and OIDC
    client are all removed. There is no undo - confirm with the user first."""
    try:
        async with await _api(ctx) as api:
            await api.delete(f"/apps/{namespace}/{name}")
            return {"deleted": f"{namespace}/{name}"}
    except ApiError as exc:
        return _error(exc)


def main() -> None:
    mcp.run(transport="http", host=settings.host, port=settings.port)


if __name__ == "__main__":
    main()
