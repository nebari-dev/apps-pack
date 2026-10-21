"""MCP OAuth: apps-mcp is an OAuth 2.0 protected resource, Keycloak the authorization server.

The MCP client (Claude Code, for one) discovers Keycloak from this server's
Protected Resource Metadata (RFC 9728), signs the user in through the browser,
and sends `Authorization: Bearer <access token>` on every request. Nothing is
kept per MCP session: each request carries its own token, which is what makes
sessionless (2026-07-28 and later) requests work like handshake-era ones.

The token is verified here against the realm JWKS (and bound to this pack's
clients) and then passed through to apps-api, which verifies it again.
"""

from __future__ import annotations

from typing import Any

import anyio
import structlog
from fastmcp.server.auth import AccessToken, AuthProvider, RemoteAuthProvider, TokenVerifier
from pydantic import AnyHttpUrl

from .config import settings

log = structlog.get_logger("nebari_apps_mcp.auth")

# Scopes advertised in the protected resource metadata. Only `openid`: every
# Keycloak client has it, and a client's default scopes (profile, email,
# groups) are added to its tokens without being asked for. Advertising a scope
# the client lacks would make Keycloak refuse the login with invalid_scope.
SCOPES_SUPPORTED = ["openid"]


class TokenVerificationError(Exception):
    pass


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
    """Signature/issuer/expiry verification against the realm JWKS.

    Defense in depth: apps-api verifies every request anyway, but verifying
    here rejects bad tokens before any tool logic runs.
    """

    def __init__(self, jwks_url: str, issuer: str, audience: str, allowed_clients: list[str] | None = None) -> None:
        import jwt

        self._issuer = issuer
        self._audience = audience
        self._allowed_clients = allowed_clients
        self._jwks = jwt.PyJWKClient(jwks_url, cache_keys=True, lifespan=300)

    def validate(self, token: str) -> dict[str, Any]:
        import jwt

        try:
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
            return claims
        except Exception as exc:  # any failure is a rejection
            raise TokenVerificationError(str(exc)) from exc


# Lazily constructed; tests inject a fake.
_validator: JWTValidator | None = None


def get_validator() -> JWTValidator:
    global _validator
    if _validator is None:
        if not settings.jwks_url:
            raise TokenVerificationError(
                "auth is enabled but no JWKS endpoint is configured (OIDC_ISSUER/OIDC_JWKS_URL)"
            )
        _validator = JWTValidator(
            settings.jwks_url,
            settings.oidc_issuer,
            settings.oidc_audience,
            settings.oidc_allowed_clients,
        )
    return _validator


class KeycloakTokenVerifier(TokenVerifier):
    """FastMCP token verifier over JWTValidator (split-horizon JWKS, azp/aud binding)."""

    async def verify_token(self, token: str) -> AccessToken | None:
        try:
            # PyJWKClient fetches the JWKS with blocking I/O on a cache miss.
            claims = await anyio.to_thread.run_sync(lambda: get_validator().validate(token))
        except TokenVerificationError as exc:
            log.info("token rejected", error=str(exc))
            return None
        exp = claims.get("exp")
        return AccessToken(
            token=token,
            client_id=str(claims.get("azp") or ""),
            scopes=str(claims.get("scope") or "").split(),
            expires_at=int(exp) if isinstance(exp, int | float) else None,
            subject=str(claims["sub"]) if claims.get("sub") else None,
            claims=claims,
        )


def build_auth_provider() -> AuthProvider | None:
    """The HTTP-layer auth for /mcp, or None when auth is disabled.

    With the issuer and the public URL known, this serves Protected Resource
    Metadata naming the Keycloak realm, and unauthenticated requests get a 401
    whose WWW-Authenticate points at it, so MCP clients can start the OAuth
    login on their own. Without them it still requires a verified bearer token,
    but cannot tell clients where to get one.
    """
    if not settings.auth_enabled:
        return None
    verifier = KeycloakTokenVerifier()
    if not (settings.oidc_issuer and settings.public_url):
        log.warning(
            "OIDC_ISSUER or MCP_PUBLIC_URL is not set: /mcp requires a bearer token but serves no "
            "OAuth protected resource metadata, so MCP clients cannot sign in on their own"
        )
        return verifier
    return RemoteAuthProvider(
        token_verifier=verifier,
        authorization_servers=[AnyHttpUrl(settings.oidc_issuer)],
        base_url=settings.public_url,
        scopes_supported=SCOPES_SUPPORTED,
        resource_name="Nebari Apps",
    )
