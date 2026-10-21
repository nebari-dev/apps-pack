"""Pydantic models mirroring the App CRD (apps.nebari.dev/v1alpha1)."""

from __future__ import annotations

import ipaddress
from typing import Annotated, Any, Literal
from urllib.parse import urlsplit

from pydantic import BaseModel, ConfigDict, Field, StringConstraints

SourceType = Literal["git", "inline", "pvc"]
SOURCE_TYPES: tuple[str, ...] = ("git", "inline", "pvc")
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


class AppSource(BaseModel):
    type: SourceType
    git: GitSource | None = None
    inline: InlineSource | None = None
    pvc: PVCSource | None = None


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
    public: bool = False
    # A private app with groups or users is enforced in the app pod by the
    # authz sidecar: a member of any group OR a listed username gets in,
    # everyone else gets 403. Both empty: any signed-in user.
    groups: list[str] = Field(default_factory=list)
    users: list[str] = Field(default_factory=list)
    # Users and groups who may manage the App like its owner; only the owner
    # and admins may change this list.
    managers: AppManagers | None = None
    subdomain: str = Field(max_length=63, pattern=r"^[a-z0-9]([-a-z0-9]*[a-z0-9])?$")


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
    access: AppAccess
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
    access: AppAccess | None = None
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
    # The caller's relationship to this App: owner, manager, admin, or ""
    # (computed per request, not stored on the CR).
    role: Role = ""


class PodMetric(BaseModel):
    name: str
    cpu: str = ""  # e.g. "12m" (millicores)
    memory: str = ""  # e.g. "34Mi"


class AppMetrics(BaseModel):
    """Instantaneous resource usage, summed per pod, from metrics.k8s.io."""

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


class AnalyticsSummary(BaseModel):
    total: int = 0
    byPhase: dict[str, int] = Field(default_factory=dict)
    bySourceType: dict[str, int] = Field(default_factory=dict)
    byNamespace: dict[str, int] = Field(default_factory=dict)
    readyReplicas: int = 0
    desiredReplicas: int = 0
