"""Pydantic models mirroring the App CRD (apps.nebari.dev/v1alpha1)."""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

Framework = Literal[
    "static", "streamlit", "panel", "gradio", "dash", "voila", "fastapi", "custom"
]
SourceType = Literal["ociEnv", "image", "git", "inline", "pvc"]


class GitSource(BaseModel):
    url: str
    ref: str = "main"
    subdir: str = ""


class ImageSource(BaseModel):
    repository: str
    tag: str = "latest"


class InlineSource(BaseModel):
    files: dict[str, str]


class PVCSource(BaseModel):
    claimName: str
    subPath: str = ""


class CodeSource(BaseModel):
    type: Literal["git", "pvc"]
    git: GitSource | None = None
    pvc: PVCSource | None = None


class OCIEnvSource(BaseModel):
    ref: str
    code: CodeSource
    entrypoint: str


class AppSource(BaseModel):
    type: SourceType
    ociEnv: OCIEnvSource | None = None
    image: ImageSource | None = None
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
    command: list[str] = Field(default_factory=list)
    env: list[EnvVar] = Field(default_factory=list)
    resources: Resources | None = None
    replicas: int = 1


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
    framework: Framework
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
    framework: str = ""
    owner: str = ""
    createdAt: str = ""
    source: AppSource | None = None
    runtime: AppRuntime | None = None
    access: AppAccess | None = None
    status: AppStatus = Field(default_factory=AppStatus)


class FrameworkInfo(BaseModel):
    name: str
    displayName: str
    sourceTypes: list[str]
    implementedSources: list[str]
    description: str = ""


class Capabilities(BaseModel):
    nebi: bool = False
    environments: str = "none"
    appsDomain: str = ""
    frameworks: list[str] = Field(default_factory=list)
    namespaces: list[str] = Field(default_factory=list)


class AnalyticsSummary(BaseModel):
    total: int = 0
    byPhase: dict[str, int] = Field(default_factory=dict)
    byFramework: dict[str, int] = Field(default_factory=dict)
    byNamespace: dict[str, int] = Field(default_factory=dict)
    readyReplicas: int = 0
    desiredReplicas: int = 0
