"""Keycloak JWT bearer authentication.

The UI logs in with keycloak-js (PKCE, public SPA client) and sends the
access token as `Authorization: Bearer <jwt>`. This module validates the
signature against the realm JWKS and extracts the user identity. Individual
launched apps do NOT use this - they sit behind the gateway's SecurityPolicy.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from fastapi import Depends, HTTPException, Request
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

from .config import settings
from .groups import group_paths
from .models import Role

_bearer = HTTPBearer(auto_error=False)


@dataclass
class User:
    username: str
    email: str = ""
    groups: list[str] = field(default_factory=list)


_ANONYMOUS = User(username="anonymous")


def is_admin(user: User) -> bool:
    """Admins see and manage every App. With auth disabled (local development
    only) the anonymous caller is treated as an admin, since there is no
    identity to scope by.
    """
    if not settings.auth_enabled:
        return True
    return bool(group_paths(user.groups) & group_paths(settings.admin_groups))


def app_owner(cr: dict[str, Any]) -> str:
    """The App's owner: spec.owner, falling back to the owner label."""
    owner = (cr.get("spec") or {}).get("owner")
    if owner:
        return str(owner)
    return str(((cr.get("metadata") or {}).get("labels") or {}).get("apps.nebari.dev/owner", ""))


def is_owner(user: User, cr: dict[str, Any]) -> bool:
    owner = app_owner(cr)
    return bool(owner) and owner == user.username


def app_managers(cr: dict[str, Any]) -> dict[str, list[str]]:
    """spec.access.managers as {"users": [...], "groups": [...]}, empty lists when unset."""
    managers = (((cr.get("spec") or {}).get("access") or {}).get("managers")) or {}
    return {key: [str(v) for v in managers.get(key) or []] for key in ("users", "groups")}


def is_manager(user: User, cr: dict[str, Any]) -> bool:
    """Listed in spec.access.managers by username (case-insensitive) or through a group in the caller's verified token,
    matched as full group paths like api.adminGroups ("web-team" is "/web-team"; a subgroup does not count).
    """
    managers = app_managers(cr)
    name = user.username.lower()
    if name and any(u.lower() == name for u in managers["users"]):
        return True
    return bool(group_paths(user.groups) & group_paths(managers["groups"]))


def app_role(user: User, cr: dict[str, Any]) -> Role:
    """The caller's relationship to an App, strongest first: "" means none."""
    if is_owner(user, cr):
        return "owner"
    if is_manager(user, cr):
        return "manager"
    if is_admin(user):
        return "admin"
    return ""


def can_access(user: User, cr: dict[str, Any]) -> bool:
    """Owner, manager or admin: the authorization rule for every App route.

    Apps without an owner (created with kubectl) are admin-and-manager-only.
    """
    return app_role(user, cr) != ""


def can_change_managers(user: User, cr: dict[str, Any]) -> bool:
    """Only the owner and admins may change who manages an App."""
    return is_owner(user, cr) or is_admin(user)


def check_client(claims: dict[str, Any], allowed: list[str] | None) -> None:
    """Raise ValueError unless the token was issued to (azp) or for (aud) one
    of the allowed clients. None disables the check.
    """
    if allowed is None:
        return
    aud = claims.get("aud") or []
    auds = [aud] if isinstance(aud, str) else list(aud)
    if claims.get("azp") in allowed or any(a in allowed for a in auds):
        return
    raise ValueError(f"token was issued to client {claims.get('azp')!r}, which is not allowed here")


class JWTValidator:
    def __init__(self, jwks_url: str, issuer: str, audience: str, allowed_clients: list[str] | None = None) -> None:
        import jwt

        self._issuer = issuer
        self._audience = audience
        self._allowed_clients = allowed_clients
        self._jwks = jwt.PyJWKClient(jwks_url, cache_keys=True, lifespan=300)

    def validate(self, token: str) -> User:
        import jwt

        signing_key = self._jwks.get_signing_key_from_jwt(token)
        claims = jwt.decode(
            token,
            signing_key.key,
            algorithms=["RS256", "ES256"],
            issuer=self._issuer or None,
            audience=self._audience or None,
            options={"verify_aud": bool(self._audience)},
        )
        check_client(claims, self._allowed_clients)
        return User(
            username=claims.get("preferred_username", claims.get("sub", "")),
            email=claims.get("email", ""),
            # Full group paths ("/finance"), as nebari-operator v0.2.0+ makes
            # Keycloak emit them; a client still sending bare names is read as
            # the top-level group of that name.
            groups=sorted(group_paths(str(g) for g in claims.get("groups") or [])),
        )


def get_validator(request: Request) -> JWTValidator | None:
    """Validator is created once and stashed on app state."""
    if not settings.auth_enabled:
        return None
    validator = getattr(request.app.state, "jwt_validator", None)
    if validator is None:
        if not settings.jwks_url:
            raise HTTPException(500, "auth is enabled but OIDC_ISSUER/OIDC_JWKS_URL is not configured")
        validator = JWTValidator(
            settings.jwks_url,
            settings.oidc_issuer,
            settings.oidc_audience,
            settings.oidc_allowed_clients,
        )
        request.app.state.jwt_validator = validator
    return validator


def current_user(
    request: Request,
    credentials: HTTPAuthorizationCredentials | None = Depends(_bearer),
) -> User:
    if not settings.auth_enabled:
        return _ANONYMOUS
    if credentials is None:
        raise HTTPException(401, "missing bearer token")
    validator = get_validator(request)
    assert validator is not None
    try:
        user = validator.validate(credentials.credentials)
    except HTTPException:
        raise
    except Exception as exc:  # any validation failure is a 401
        raise HTTPException(401, f"invalid token: {exc}") from exc
    # Picked up by the access log line (RequestIdMiddleware).
    request.state.user = user.username
    return user
