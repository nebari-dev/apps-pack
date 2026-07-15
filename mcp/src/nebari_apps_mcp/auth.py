"""Keycloak device-flow authentication (RFC 8628) with per-session tokens.

The MCP server is shared, so tokens are cached per MCP session id - one
agent's login never leaks into another session. Clients that already have a
token can skip the device flow entirely by sending an Authorization header;
it is passed through to apps-api unchanged.
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field

import httpx

from .config import settings


@dataclass
class TokenState:
    access_token: str = ""
    refresh_token: str = ""
    expires_at: float = 0.0
    # An in-flight device authorization, if any.
    device_code: str = ""
    verification_uri: str = ""
    user_code: str = ""
    interval: float = 5.0
    device_expires_at: float = 0.0

    @property
    def valid(self) -> bool:
        return bool(self.access_token) and time.time() < self.expires_at - 15


@dataclass
class DeviceFlowAuth:
    _sessions: dict[str, TokenState] = field(default_factory=dict)

    def state(self, session_id: str) -> TokenState:
        return self._sessions.setdefault(session_id or "anonymous", TokenState())

    async def authenticate(self, session_id: str) -> dict:
        """Start, poll, or confirm a device-flow login for this session."""
        if not settings.auth_enabled:
            return {
                "status": "not_required",
                "message": "authentication is disabled on this cluster; tools work without logging in",
            }
        if not settings.oidc_issuer or not settings.oidc_device_client_id:
            return {
                "status": "unavailable",
                "message": "the device-flow client is not configured; ask the operator to set "
                "keycloak.url (the OIDC secret provides the client id once the NebariApp reconciles)",
            }

        state = self.state(session_id)

        if state.valid:
            return {"status": "authenticated", "message": "already logged in; token is valid"}

        if state.refresh_token and await self._refresh(state):
            return {"status": "authenticated", "message": "session refreshed; token is valid"}

        async with httpx.AsyncClient(timeout=15) as client:
            # Poll an in-flight device authorization first.
            if state.device_code and time.time() < state.device_expires_at:
                result = await self._poll(client, state)
                if result is not None:
                    return result

            # Start a new device authorization.
            resp = await client.post(
                settings.device_endpoint,
                data={"client_id": settings.oidc_device_client_id, "scope": "openid profile email groups"},
            )
            resp.raise_for_status()
            data = resp.json()
            state.device_code = data["device_code"]
            state.user_code = data["user_code"]
            state.verification_uri = data.get("verification_uri_complete") or data["verification_uri"]
            state.interval = float(data.get("interval", 5))
            state.device_expires_at = time.time() + float(data.get("expires_in", 600))

        return {
            "status": "action_required",
            "verificationUrl": state.verification_uri,
            "userCode": state.user_code,
            "message": (
                f"Ask the user to open {state.verification_uri} and approve the login "
                f"(code: {state.user_code}). Then call the authenticate tool again to complete."
            ),
        }

    async def _poll(self, client: httpx.AsyncClient, state: TokenState) -> dict | None:
        """One token-endpoint poll. None means the flow is dead - restart it."""
        resp = await client.post(
            settings.token_endpoint,
            data={
                "grant_type": "urn:ietf:params:oauth:grant-type:device_code",
                "client_id": settings.oidc_device_client_id,
                "device_code": state.device_code,
            },
        )
        if resp.status_code == 200:
            self._store(state, resp.json())
            return {"status": "authenticated", "message": "login approved; token cached for this session"}
        error = resp.json().get("error", "")
        if error == "authorization_pending":
            return {
                "status": "pending",
                "verificationUrl": state.verification_uri,
                "userCode": state.user_code,
                "message": "the user has not approved the login yet; ask them to finish, then retry",
            }
        if error == "slow_down":
            state.interval += 5
            return {"status": "pending", "message": "polling too fast; wait a few seconds and retry"}
        # expired_token / access_denied / anything else: restart the flow.
        state.device_code = ""
        return None

    async def _refresh(self, state: TokenState) -> bool:
        try:
            async with httpx.AsyncClient(timeout=15) as client:
                resp = await client.post(
                    settings.token_endpoint,
                    data={
                        "grant_type": "refresh_token",
                        "client_id": settings.oidc_device_client_id,
                        "refresh_token": state.refresh_token,
                    },
                )
            if resp.status_code != 200:
                return False
            self._store(state, resp.json())
            return True
        except httpx.HTTPError:
            return False

    def _store(self, state: TokenState, data: dict) -> None:
        state.access_token = data["access_token"]
        state.refresh_token = data.get("refresh_token", state.refresh_token)
        state.expires_at = time.time() + float(data.get("expires_in", 300))
        state.device_code = ""

    async def bearer(self, session_id: str, passthrough: str = "") -> str:
        """The Authorization value for apps-api calls, or '' when anonymous."""
        if passthrough:
            return passthrough
        if not settings.auth_enabled:
            return ""
        state = self.state(session_id)
        if not state.valid and state.refresh_token:
            await self._refresh(state)
        return f"Bearer {state.access_token}" if state.valid else ""


auth = DeviceFlowAuth()


class TokenVerificationError(Exception):
    pass


class JWTValidator:
    """Signature/issuer/expiry verification against the realm JWKS.

    Defense in depth: apps-api verifies every request anyway, but verifying
    here rejects bad tokens before any tool logic runs.
    """

    def __init__(self, jwks_url: str, issuer: str, audience: str) -> None:
        import jwt

        self._issuer = issuer
        self._audience = audience
        self._jwks = jwt.PyJWKClient(jwks_url, cache_keys=True, lifespan=300)

    def validate(self, token: str) -> dict:
        import jwt

        try:
            signing_key = self._jwks.get_signing_key_from_jwt(token)
            return jwt.decode(
                token,
                signing_key.key,
                algorithms=["RS256", "ES256"],
                issuer=self._issuer or None,
                audience=self._audience or None,
                options={"verify_aud": bool(self._audience)},
            )
        except Exception as exc:  # noqa: BLE001 - any failure is a rejection
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
        _validator = JWTValidator(settings.jwks_url, settings.oidc_issuer, settings.oidc_audience)
    return _validator
