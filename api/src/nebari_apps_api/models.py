"""Pydantic models mirroring the App CRD (apps.nebari.dev/v1alpha1)."""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

SourceType = Literal["git", "inline", "pvc"]
SOURCE_TYPES: tuple[str, ...] = ("git", "inline", "pvc")


class GitSource(BaseModel):
    url: str
    ref: str = "main"
    subdir: str = ""


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
    name: str
    value: str = ""


class ResourceAmounts(BaseModel):
    cpu: str | None = None
    memory: str | None = None


class Resources(BaseModel):
    requests: ResourceAmounts | None = None
    limits: ResourceAmounts | None = None


class AppRuntime(BaseModel):
    env: list[EnvVar] = Field(default_factory=list)
    resources: Resources | None = None
    replicas: int = 1
    # When set, the app runs as a Python/pixi service: the operator installs
    # the pixi environment and executes `pixi run <pixiTask>`. The task must
    # start a server listening on 0.0.0.0:8080.
    pixiTask: str = Field(default="", max_length=64)


class AppAccess(BaseModel):
    public: bool = False
    groups: list[str] = Field(default_factory=list)
    users: list[str] = Field(default_factory=list)
    subdomain: str


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


class AppPatch(BaseModel):
    """Request body for PATCH /apps - all fields optional."""

    model_config = ConfigDict(extra="forbid")

    displayName: str | None = None
    description: str | None = None
    thumbnail: str | None = None
    source: AppSource | None = None
    runtime: AppRuntime | None = None
    access: AppAccess | None = None


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
    phase: str = "Pending"
    url: str = ""
    replicas: AppReplicas | None = None
    conditions: list[AppCondition] = Field(default_factory=list)
    message: str = ""


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
    status: AppStatus = Field(default_factory=AppStatus)


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


class AnalyticsSummary(BaseModel):
    total: int = 0
    byPhase: dict[str, int] = Field(default_factory=dict)
    bySourceType: dict[str, int] = Field(default_factory=dict)
    byNamespace: dict[str, int] = Field(default_factory=dict)
    readyReplicas: int = 0
    desiredReplicas: int = 0
