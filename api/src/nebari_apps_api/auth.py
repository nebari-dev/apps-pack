"""Keycloak JWT bearer authentication.

The UI logs in with keycloak-js (PKCE, public SPA client) and sends the
access token as `Authorization: Bearer <jwt>`. This module validates the
signature against the realm JWKS and extracts the user identity. Individual
launched apps do NOT use this - they sit behind the gateway's SecurityPolicy.
"""

from __future__ import annotations

from dataclasses import dataclass, field

from fastapi import Depends, HTTPException, Request
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

from .config import settings

_bearer = HTTPBearer(auto_error=False)


@dataclass
class User:
    username: str
    email: str = ""
    groups: list[str] = field(default_factory=list)


_ANONYMOUS = User(username="anonymous")


class JWTValidator:
    def __init__(self, jwks_url: str, issuer: str, audience: str) -> None:
        import jwt

        self._issuer = issuer
        self._audience = audience
        self._jwks = jwt.PyJWKClient(jwks_url, cache_keys=True, lifespan=300)

    def validate(self, token: str) -> User:
        import jwt

        signing_key = self._jwks.get_signing_key_from_jwt(token)
        options = {"verify_aud": bool(self._audience)}
        claims = jwt.decode(
            token,
            signing_key.key,
            algorithms=["RS256", "ES256"],
            issuer=self._issuer or None,
            audience=self._audience or None,
            options=options,
        )
        return User(
            username=claims.get("preferred_username", claims.get("sub", "")),
            email=claims.get("email", ""),
            groups=[g.lstrip("/") for g in claims.get("groups", [])],
        )


def get_validator(request: Request) -> JWTValidator | None:
    """Validator is created once and stashed on app state."""
    if not settings.auth_enabled:
        return None
    validator = getattr(request.app.state, "jwt_validator", None)
    if validator is None:
        if not settings.jwks_url:
            raise HTTPException(500, "auth is enabled but OIDC_ISSUER/OIDC_JWKS_URL is not configured")
        validator = JWTValidator(settings.jwks_url, settings.oidc_issuer, settings.oidc_audience)
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
        return validator.validate(credentials.credentials)
    except HTTPException:
        raise
    except Exception as exc:  # noqa: BLE001 - any validation failure is a 401
        raise HTTPException(401, f"invalid token: {exc}") from exc
