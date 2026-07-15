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
    # Domain apps are exposed under: https://<subdomain>.<apps_domain>.
    apps_domain: str = field(default_factory=lambda: os.environ.get("APPS_DOMAIN", "apps.nebari.local"))

    # Namespaces users may launch apps into (comma-separated). Empty means
    # "any namespace labeled nebari.dev/managed=true".
    allowed_namespaces: list[str] = field(
        default_factory=lambda: [
            ns.strip()
            for ns in os.environ.get("APPS_NAMESPACES", "").split(",")
            if ns.strip()
        ]
    )

    # --- Auth (Keycloak JWT bearer) ---
    auth_enabled: bool = field(default_factory=lambda: _env_bool("AUTH_ENABLED", True))
    # Issuer as it appears in tokens (browser-facing Keycloak realm URL).
    oidc_issuer: str = field(default_factory=lambda: os.environ.get("OIDC_ISSUER", ""))
    # JWKS endpoint reachable from inside the cluster; defaults to the
    # standard Keycloak path under the issuer.
    oidc_jwks_url: str = field(default_factory=lambda: os.environ.get("OIDC_JWKS_URL", ""))
    # In-cluster issuer URL (split horizon): used only to reach JWKS when the
    # browser-facing issuer is not resolvable from inside the cluster.
    oidc_issuer_internal: str = field(default_factory=lambda: os.environ.get("OIDC_ISSUER_INTERNAL", ""))
    # Optional audience check (client id); empty disables the aud check.
    oidc_audience: str = field(default_factory=lambda: os.environ.get("OIDC_AUDIENCE", ""))

    # Values surfaced to the UI via /api/v1/config so keycloak-js can boot.
    ui_keycloak_url: str = field(default_factory=lambda: os.environ.get("UI_KEYCLOAK_URL", ""))
    ui_keycloak_realm: str = field(default_factory=lambda: os.environ.get("UI_KEYCLOAK_REALM", "nebari"))
    ui_keycloak_client_id: str = field(default_factory=lambda: os.environ.get("UI_KEYCLOAK_CLIENT_ID", ""))

    # Serve apps over plain HTTP (mirrors the operator's --tls-disabled).
    tls_disabled: bool = field(default_factory=lambda: _env_bool("TLS_DISABLED", False))

    # Upload limits for the inline (ConfigMap-backed) source path.
    max_upload_bytes: int = field(
        default_factory=lambda: int(os.environ.get("MAX_UPLOAD_BYTES", str(900 * 1024)))
    )

    @property
    def jwks_url(self) -> str:
        if self.oidc_jwks_url:
            return self.oidc_jwks_url
        base = self.oidc_issuer_internal or self.oidc_issuer
        if base:
            return f"{base.rstrip('/')}/protocol/openid-connect/certs"
        return ""


settings = Settings()
