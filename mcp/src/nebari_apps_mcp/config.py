"""Runtime configuration from environment variables."""

from __future__ import annotations

import os
from dataclasses import dataclass, field


def _env_bool(key: str, default: bool) -> bool:
    val = os.environ.get(key)
    if val is None:
        return default
    return val.strip().lower() in ("1", "true", "yes", "on")


@dataclass
class Settings:
    # In-cluster base URL of apps-api (no trailing slash), e.g.
    # http://nebari-apps-api.nebari-apps.svc.cluster.local:8080
    api_url: str = field(default_factory=lambda: os.environ.get("API_URL", "http://localhost:8000"))

    # When false (local dev), tools call apps-api anonymously and the
    # authenticate tool reports that auth is disabled.
    auth_enabled: bool = field(default_factory=lambda: _env_bool("AUTH_ENABLED", True))

    # Browser-facing Keycloak realm issuer for the device flow, e.g.
    # https://keycloak.example.ai/auth/realms/nebari. The verification URL
    # returned to users comes from here, so it must be browser-reachable.
    oidc_issuer: str = field(default_factory=lambda: os.environ.get("OIDC_ISSUER", ""))

    # Public device-flow client id, provisioned by this pack's NebariApp
    # (auth.deviceFlowClient) and read from its OIDC secret.
    oidc_device_client_id: str = field(
        default_factory=lambda: os.environ.get("OIDC_DEVICE_CLIENT_ID", "")
    )

    # In-cluster issuer URL (split horizon): used only to reach JWKS when the
    # browser-facing issuer is not resolvable from inside the cluster.
    oidc_issuer_internal: str = field(
        default_factory=lambda: os.environ.get("OIDC_ISSUER_INTERNAL", "")
    )
    # Explicit JWKS endpoint override.
    oidc_jwks_url: str = field(default_factory=lambda: os.environ.get("OIDC_JWKS_URL", ""))
    # Optional audience check; empty disables it.
    oidc_audience: str = field(default_factory=lambda: os.environ.get("OIDC_AUDIENCE", ""))

    host: str = field(default_factory=lambda: os.environ.get("HOST", "0.0.0.0"))
    port: int = field(default_factory=lambda: int(os.environ.get("PORT", "8080")))

    @property
    def device_endpoint(self) -> str:
        return f"{self.oidc_issuer.rstrip('/')}/protocol/openid-connect/auth/device"

    @property
    def token_endpoint(self) -> str:
        return f"{self.oidc_issuer.rstrip('/')}/protocol/openid-connect/token"

    @property
    def jwks_url(self) -> str:
        if self.oidc_jwks_url:
            return self.oidc_jwks_url
        base = self.oidc_issuer_internal or self.oidc_issuer
        if base:
            return f"{base.rstrip('/')}/protocol/openid-connect/certs"
        return ""


settings = Settings()
