"""Pydantic models mirroring the App CRD (apps.nebari.dev/v1alpha1)."""

from __future__ import annotations

import ipaddress
from typing import Annotated, Any, Literal
from urllib.parse import urlsplit

from pydantic import BaseModel, ConfigDict, Field, StringConstraints

SourceType = Literal["git", "inline", "pvc", "image"]
SOURCE_TYPES: tuple[str, ...] = ("git", "inline", "pvc", "image")
# The caller's relationship to an App (AppOut.role); "" means none.
Role = Literal["owner", "manager", "admin", ""]


# Hosts a git source may never point at: the clone runs inside the cluster,
# so these would reach cluster-internal services (SSRF). Mirrors
# operator/internal/controller/gitsource.go.
_INTERNAL_SUFFIXES = (".localhost", ".svc", ".cluster.local", ".internal", ".local")


def _check_git_url(raw: str) -> str:
    if raw.startswith("-"):
        raise ValueError("must not start with '-'")
    parts = urlsplit(raw)
    if parts.scheme != "https":
        raise ValueError("only https:// URLs are allowed")
    if parts.username is not None or parts.password is not None or "@" in parts.netloc:
        raise ValueError("must not contain credentials (user:token@); use a public repository")
    host = (parts.hostname or "").lower()
    if not host:
        raise ValueError("missing host")
    try:
        ip = ipaddress.ip_address(host)
    except ValueError:
        internal = host == "localhost" or "." not in host or host.endswith(_INTERNAL_SUFFIXES)
    else:
        internal = ip.is_loopback or ip.is_private or ip.is_link_local or ip.is_unspecified
    if internal:
        raise ValueError(f"host {host!r} is not allowed: cluster-internal and private addresses are blocked")
    return raw


class GitSource(BaseModel):
    url: str
    ref: str = "main"
    subdir: str = ""

    def check(self) -> None:
        """Raise ValueError if this source is unsafe to clone. Applied to
        requests only, so Apps created with kubectl stay readable.
        """
        _check_git_url(self.url)
        if self.ref.startswith("-"):
            raise ValueError("ref must not start with '-'")


class InlineSource(BaseModel):
    files: dict[str, str]


class PVCSource(BaseModel):
    claimName: str
    subPath: str = ""


# Ports the apps-authz sidecar takes in every image App's pod (its listener
# and its probe port), so the image may not listen on them.
IMAGE_RESERVED_PORTS = (8080, 8082)
IMAGE_PORT_MIN = 1024
IMAGE_PORT_MAX = 65535
IMAGE_REFERENCE_MAX_LENGTH = 512
IMAGE_MAX_ARGS = 64
IMAGE_ARG_MAX_LENGTH = 4096
ImageArg = Annotated[str, StringConstraints(max_length=IMAGE_ARG_MAX_LENGTH)]


class ImageSource(BaseModel):
    """A prebuilt container image run as the app container. The reference
    must carry a tag or digest and match the registry allowlist (images.py).
    """

    reference: str = Field(min_length=1, max_length=IMAGE_REFERENCE_MAX_LENGTH)
    port: int = Field(ge=IMAGE_PORT_MIN, le=IMAGE_PORT_MAX)
    command: list[ImageArg] = Field(default_factory=list, max_length=IMAGE_MAX_ARGS)
    args: list[ImageArg] = Field(default_factory=list, max_length=IMAGE_MAX_ARGS)
    # A non-zero uid for images whose USER is a name; images never run as root.
    runAsUser: int | None = Field(default=None, ge=1)


class AppSource(BaseModel):
    type: SourceType
    git: GitSource | None = None
    inline: InlineSource | None = None
    pvc: PVCSource | None = None
    image: ImageSource | None = None


class EnvVar(BaseModel):
    """A Kubernetes EnvVar: a literal `value`, or `valueFrom` (a Secret,
    ConfigMap or field reference, passed through as written).
    """

    name: str
    value: str = ""
    valueFrom: dict[str, Any] | None = None


class Resources(BaseModel):
    """Kubernetes ResourceRequirements. Any resource name is kept (cpu,
    memory, ephemeral-storage, extended resources such as nvidia.com/gpu),
    so an App authored with kubectl keeps them through an edit.
    """

    model_config = ConfigDict(extra="allow")

    requests: dict[str, str] | None = None
    limits: dict[str, str] | None = None


# A secret key is injected as an environment variable of the same name, so
# it must be one (mirrors the CRD's runtime.secretKeys items).
SECRET_KEY_PATTERN = r"^[A-Za-z_][A-Za-z0-9_]*$"
SECRET_KEY_MAX_LENGTH = 128
MAX_SECRET_KEYS = 64
SecretKey = Annotated[str, StringConstraints(pattern=SECRET_KEY_PATTERN, max_length=SECRET_KEY_MAX_LENGTH)]


class AppRuntime(BaseModel):
    env: list[EnvVar] = Field(default_factory=list)
    # Names of the keys in the App's Secret (app-<name>-secrets), each
    # injected as an env var. Managed by the API from `secrets` in requests:
    # a value sent here is ignored. Values are never returned.
    secretKeys: list[str] | None = Field(default=None, max_length=MAX_SECRET_KEYS)
    resources: Resources | None = None
    replicas: int = Field(default=1, ge=0, le=10)
    # Exempts the app from scale-to-zero: it keeps running without requests.
    keepAlive: bool | None = None
    # Minutes without a request before the operator scales the app to zero
    # (phase Idle); unset uses the cluster default (chart
    # apps.idle.timeoutMinutes). Ignored when keepAlive is true.
    idleTimeoutMinutes: int | None = Field(default=None, ge=5, le=43200)
    # When set, the app runs as a Python/pixi service: the operator installs
    # the pixi environment and executes `pixi run <pixiTask>`. The task must
    # start a server on $PORT (8080, or 8081 when the sidecar fronts it:
    # restricted apps and apps that can idle).
    pixiTask: str = Field(default="", max_length=64)


class AppManagers(BaseModel):
    """Who may manage the App besides its owner (not who may open it)."""

    users: list[str] = Field(default_factory=list)
    groups: list[str] = Field(default_factory=list)


class AppAccess(BaseModel):
    # Unknown keys are ignored on reads: an App stored before the users list was
    # removed from access may still carry it (the apiserver prunes it on the next write).
    public: bool = False
    # A private app with groups is enforced in the app pod by the authz
    # sidecar: a member of any group gets in, everyone else gets 403. Empty:
    # any signed-in user.
    groups: list[str] = Field(default_factory=list)
    # Users and groups who may manage the App like its owner; only the owner
    # and admins may change this list.
    managers: AppManagers | None = None
    subdomain: str = Field(max_length=63, pattern=r"^[a-z0-9]([-a-z0-9]*[a-z0-9])?$")


class AppAccessRequest(AppAccess):
    """access in a create or patch body. Unknown keys are refused, so a client
    still sending the removed users list gets a 422 instead of an App that is
    silently open to more people than it asked for.
    """

    model_config = ConfigDict(extra="forbid")


class AppLandingPage(BaseModel):
    """Whether the app is registered as a tile on the Nebari landing page.

    Unset (None) means "use the cluster default" (chart value
    apps.landingPage.enabled, off unless the operator enables it).
    """

    enabled: bool | None = None


class AppCreate(BaseModel):
    """Request body for POST /apps (mirrors App.spec plus name/namespace)."""

    model_config = ConfigDict(extra="forbid")

    name: str = Field(pattern=r"^[a-z0-9]([-a-z0-9]*[a-z0-9])?$", max_length=53)
    namespace: str
    displayName: str
    description: str = ""
    thumbnail: str = ""
    source: AppSource
    runtime: AppRuntime = Field(default_factory=AppRuntime)
    access: AppAccessRequest
    landingPage: AppLandingPage | None = None
    # Write-only secret values: stored in the App's Secret, never in the App
    # and never returned; runtime.secretKeys lists their names.
    secrets: dict[SecretKey, str] = Field(default_factory=dict, max_length=MAX_SECRET_KEYS)


class AppPatch(BaseModel):
    """Request body for PATCH /apps - all fields optional."""

    model_config = ConfigDict(extra="forbid")

    displayName: str | None = None
    description: str | None = None
    thumbnail: str | None = None
    source: AppSource | None = None
    runtime: AppRuntime | None = None
    access: AppAccessRequest | None = None
    landingPage: AppLandingPage | None = None
    # Set or rotate (a value) or remove (null) secret keys; keys not sent are
    # kept. Write-only, like AppCreate.secrets.
    secrets: dict[SecretKey, str | None] | None = Field(default=None, max_length=MAX_SECRET_KEYS)


class AppReplicas(BaseModel):
    desired: int = 0
    ready: int = 0


class AppCondition(BaseModel):
    type: str
    status: str
    reason: str = ""
    message: str = ""
    lastTransitionTime: str = ""


class AppStatus(BaseModel):
    # Pending | Deploying | Running | Failed | Stopped | Idle
    phase: str = "Pending"
    url: str = ""
    replicas: AppReplicas | None = None
    conditions: list[AppCondition] = Field(default_factory=list)
    message: str = ""
    # When the app last served a request (apps that can idle only).
    lastActivityTime: str = ""
    # The metadata.generation the operator last reconciled; below AppOut.generation
    # while it has yet to act on a spec change (0 before its first reconcile).
    observedGeneration: int = 0


class AppOut(BaseModel):
    """An App as returned by the API."""

    name: str
    namespace: str
    displayName: str = ""
    description: str = ""
    thumbnail: str = ""
    owner: str = ""
    createdAt: str = ""
    source: AppSource | None = None
    runtime: AppRuntime | None = None
    access: AppAccess | None = None
    landingPage: AppLandingPage | None = None
    status: AppStatus = Field(default_factory=AppStatus)
    # metadata.generation: bumped by the apiserver on every spec change.
    generation: int = 0
    # The caller's relationship to this App: owner, manager, admin, or ""
    # (computed per request, not stored on the CR).
    role: Role = ""


class PodResources(BaseModel):
    """The `app` container's CPU and memory, as requests or limits ("" when unset)."""

    cpu: str = ""  # e.g. "500m" (millicores)
    memory: str = ""  # e.g. "512Mi"


class PodTermination(BaseModel):
    """How the `app` container's previous run ended (its lastState.terminated)."""

    # The kubelet's or runtime's CamelCase reason, e.g. OOMKilled, Error,
    # Completed; "" when absent or not a plain identifier (it never carries
    # the container's own termination message).
    reason: str = ""
    exitCode: int = 0
    finishedAt: str = ""  # RFC 3339, UTC


class PodMetric(BaseModel):
    """One app pod: usage from metrics.k8s.io, health and resources from the pod."""

    name: str
    cpu: str = ""  # e.g. "12m" (millicores); "" without a metrics server
    memory: str = ""  # e.g. "34Mi"; "" without a metrics server
    # Restarts of the `app` container (the authz sidecar's are not counted).
    restarts: int = 0
    lastTermination: PodTermination | None = None
    # When the `app` container last started running; None while it is not running.
    startedAt: str | None = None
    limits: PodResources = Field(default_factory=PodResources)
    requests: PodResources = Field(default_factory=PodResources)


class AppMetrics(BaseModel):
    """Per-pod usage and health of an App.

    available is true when metrics.k8s.io answered, so cpu/memory usage is
    present. The pod-status fields (restarts, lastTermination, startedAt,
    limits, requests) come from the pods themselves and are filled either way.
    """

    available: bool = False
    pods: list[PodMetric] = Field(default_factory=list)


class AppUsage(BaseModel):
    namespace: str
    name: str
    cpu: int = 0  # millicores
    memory: int = 0  # Mi
    restarts: int = 0


class NamespaceUsage(BaseModel):
    namespace: str
    cpu: int = 0  # millicores
    memory: int = 0  # Mi


class ClusterMetrics(BaseModel):
    """Cluster-wide, right-now usage per app and per namespace.

    usageAvailable is false when the cluster has no metrics server; restart
    counts come from pod status and are always populated.
    """

    usageAvailable: bool = False
    apps: list[AppUsage] = Field(default_factory=list)
    byNamespace: list[NamespaceUsage] = Field(default_factory=list)


class Capabilities(BaseModel):
    appsDomain: str = ""
    sourceTypes: list[str] = Field(default_factory=list)
    namespaces: list[str] = Field(default_factory=list)
    # Cluster default idle timeout (0: apps stay up unless they set one).
    idleTimeoutMinutes: int = 0
    # Registry allowlist for source type image (normalized; empty: off, and
    # "image" is left out of sourceTypes).
    imageRegistries: list[str] = Field(default_factory=list)


class AnalyticsSummary(BaseModel):
    total: int = 0
    byPhase: dict[str, int] = Field(default_factory=dict)
    bySourceType: dict[str, int] = Field(default_factory=dict)
    byNamespace: dict[str, int] = Field(default_factory=dict)
    readyReplicas: int = 0
    desiredReplicas: int = 0
