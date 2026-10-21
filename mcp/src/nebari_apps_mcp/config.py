"""Runtime configuration from environment variables."""

from __future__ import annotations

import os
from dataclasses import dataclass, field


def _env_bool(key: str, default: bool) -> bool:
    val = os.environ.get(key)
    if val is None:
        return default
    return val.strip().lower() in ("1", "true", "yes", "on")


def _client_list(key: str) -> list[str] | None:
    """Comma-separated client ids, or None when the variable is unset.

    Set-but-empty (or unexpanded `$(VAR)` references from a missing secret)
    yields an empty list, which rejects every token: fail closed.
    """
    raw = os.environ.get(key)
    if raw is None:
        return None
    return [c.strip() for c in raw.split(",") if c.strip() and not c.strip().startswith("$(")]


@dataclass
class Settings:
    # In-cluster base URL of apps-api (no trailing slash), e.g.
    # http://nebari-apps-api.nebari-apps.svc.cluster.local:8080
    api_url: str = field(default_factory=lambda: os.environ.get("API_URL", "http://localhost:8000"))

    # When false (local dev), /mcp needs no token and tools call apps-api
    # anonymously.
    auth_enabled: bool = field(default_factory=lambda: _env_bool("AUTH_ENABLED", True))

    # Browser-facing Keycloak realm issuer, e.g.
    # https://keycloak.example.ai/auth/realms/nebari. Tokens must carry it as
    # `iss`, and the protected resource metadata names it as the authorization
    # server MCP clients sign in with, so it must be browser-reachable.
    oidc_issuer: str = field(default_factory=lambda: os.environ.get("OIDC_ISSUER", ""))

    # Public origin agents reach this server at (no path), e.g.
    # https://apps.example.ai: the MCP endpoint is <public_url>/mcp, which is
    # the `resource` the protected resource metadata advertises.
    public_url: str = field(default_factory=lambda: os.environ.get("MCP_PUBLIC_URL", "").rstrip("/"))

    # In-cluster issuer URL (split horizon): used only to reach JWKS when the
    # browser-facing issuer is not resolvable from inside the cluster.
    oidc_issuer_internal: str = field(default_factory=lambda: os.environ.get("OIDC_ISSUER_INTERNAL", ""))
    # Explicit JWKS endpoint override.
    oidc_jwks_url: str = field(default_factory=lambda: os.environ.get("OIDC_JWKS_URL", ""))
    # Optional audience check; empty disables it.
    oidc_audience: str = field(default_factory=lambda: os.environ.get("OIDC_AUDIENCE", ""))
    # Bind tokens to this pack's own Keycloak clients: a token is accepted
    # only if its azp (the client it was issued to) or one of its aud values
    # is listed. Keycloak puts the SPA client in azp (aud is just "account"),
    # so a plain audience check cannot do this. Unset disables the check.
    oidc_allowed_clients: list[str] | None = field(default_factory=lambda: _client_list("OIDC_ALLOWED_CLIENTS"))

    host: str = field(default_factory=lambda: os.environ.get("HOST", "0.0.0.0"))
    port: int = field(default_factory=lambda: int(os.environ.get("PORT", "8080")))

    @property
    def jwks_url(self) -> str:
        if self.oidc_jwks_url:
            return self.oidc_jwks_url
        base = self.oidc_issuer_internal or self.oidc_issuer
        if base:
            return f"{base.rstrip('/')}/protocol/openid-connect/certs"
        return ""


settings = Settings()
