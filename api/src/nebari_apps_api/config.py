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
    # Domain apps are exposed under: https://<subdomain>.<apps_domain>.
    apps_domain: str = field(default_factory=lambda: os.environ.get("APPS_DOMAIN", "apps.nebari.local"))

    # Namespaces users may launch apps into (comma-separated). Empty means
    # "any namespace labeled nebari.dev/managed=true".
    allowed_namespaces: list[str] = field(
        default_factory=lambda: [ns.strip() for ns in os.environ.get("APPS_NAMESPACES", "").split(",") if ns.strip()]
    )

    # Keycloak groups whose members may see and manage every App. Everyone
    # else sees and manages only the Apps they own (spec.owner). Group names
    # are compared without a leading "/" (Keycloak full-path groups).
    admin_groups: list[str] = field(
        default_factory=lambda: [
            g.strip().lstrip("/") for g in os.environ.get("APPS_ADMIN_GROUPS", "admin").split(",") if g.strip()
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
    # Bind tokens to this pack's own Keycloak clients: a token is accepted
    # only if its azp (the client it was issued to) or one of its aud values
    # is listed. Keycloak puts the SPA client in azp (aud is just "account"),
    # so a plain audience check cannot do this. Unset disables the check.
    oidc_allowed_clients: list[str] | None = field(default_factory=lambda: _client_list("OIDC_ALLOWED_CLIENTS"))

    # Values surfaced to the UI via /api/v1/config so keycloak-js can boot.
    ui_keycloak_url: str = field(default_factory=lambda: os.environ.get("UI_KEYCLOAK_URL", ""))
    ui_keycloak_realm: str = field(default_factory=lambda: os.environ.get("UI_KEYCLOAK_REALM", "nebari"))
    ui_keycloak_client_id: str = field(default_factory=lambda: os.environ.get("UI_KEYCLOAK_CLIENT_ID", ""))

    # The image this API runs from (the chart passes its image tag, sha-<commit>
    # for released charts), reported next to the version by /api/v1/version.
    build: str = field(default_factory=lambda: os.environ.get("APPS_BUILD", "unknown"))

    # Cluster default idle timeout in minutes (mirrors the operator's
    # --idle-timeout-minutes; 0 = apps never idle unless they set
    # runtime.idleTimeoutMinutes). Reported by /capabilities for forms.
    idle_timeout_minutes: int = field(default_factory=lambda: int(os.environ.get("IDLE_TIMEOUT_MINUTES", "0") or 0))

    # Serve apps over plain HTTP (mirrors the operator's --tls-disabled).
    tls_disabled: bool = field(default_factory=lambda: _env_bool("TLS_DISABLED", False))

    # Upload limits for the inline (ConfigMap-backed) source path.
    max_upload_bytes: int = field(default_factory=lambda: int(os.environ.get("MAX_UPLOAD_BYTES", str(900 * 1024))))
    # Hard ceiling on any request body, enforced while it streams in (before
    # parsing), so no request can make the API buffer more than this. Matches
    # the UI nginx client_max_body_size (2m) and leaves room for multipart
    # overhead around a max_upload_bytes file.
    max_request_bytes: int = field(
        default_factory=lambda: int(os.environ.get("MAX_REQUEST_BYTES", str(2 * 1024 * 1024)))
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
