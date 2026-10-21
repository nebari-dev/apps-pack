"""The middleware must reject unverified callers on every tool call and resource read.

There is no login tool and nothing is cached per MCP session: the token on the
request is the only identity. test_oauth.py covers the HTTP-layer OAuth (401
challenges, protected resource metadata); these cover the in-process check
that runs behind it on every transport.
"""

from __future__ import annotations

import time

import pytest
from fastmcp import Client
from fastmcp.exceptions import ToolError

from nebari_apps_mcp import auth as auth_mod
from nebari_apps_mcp.auth import TokenVerificationError
from nebari_apps_mcp.config import settings as mcp_settings
from nebari_apps_mcp.server import mcp


class FakeValidator:
    """Accepts exactly one token value."""

    def __init__(self, good: str = "good-token") -> None:
        self.good = good

    def validate(self, token: str) -> dict:
        if token == self.good:
            return {"preferred_username": "alice"}
        raise TokenVerificationError("signature verification failed")


@pytest.fixture
def auth_on(monkeypatch):
    monkeypatch.setattr(mcp_settings, "auth_enabled", True)
    monkeypatch.setattr(auth_mod, "_validator", FakeValidator())


async def test_tools_rejected_without_token(auth_on):
    async with Client(mcp) as client:
        tools = {t.name for t in await client.list_tools()}
        assert "authenticate" not in tools
        with pytest.raises(ToolError, match="not authenticated: sign in"):
            await client.call_tool("describe_cluster", {})
        with pytest.raises(ToolError, match="not authenticated: sign in"):
            await client.call_tool("list_apps", {})


async def test_non_bearer_authorization_rejected(auth_on):
    from fastmcp.utilities.tests import asgi_client

    async with asgi_client(mcp, headers={"Authorization": "Basic Z29vZC10b2tlbg=="}) as client:
        with pytest.raises(ToolError, match="not authenticated"):
            await client.call_tool("describe_cluster", {})


async def test_auth_disabled_skips_verification():
    # The default fixtures run with auth disabled; no token, tools work.
    async with Client(mcp) as client:
        caps = (await client.call_tool("describe_cluster", {})).data
        assert "namespaces" in caps


def test_jwt_validator_binds_tokens_to_pack_clients():
    """Real RS256 tokens: a valid token issued to another realm client is refused."""
    import jwt
    from cryptography.hazmat.primitives.asymmetric import rsa

    from nebari_apps_mcp.auth import JWTValidator

    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    issuer = "https://keycloak.example.test/realms/nebari"

    class _Key:
        pass

    _Key.key = key.public_key()
    v = JWTValidator("https://unused.example.test/certs", issuer, "", ["apps-ui-device", "apps-ui-spa"])
    v._jwks.get_signing_key_from_jwt = lambda _t: _Key()  # type: ignore[method-assign]

    def tok(azp, aud="account"):
        return jwt.encode(
            {"iss": issuer, "azp": azp, "aud": aud, "exp": int(time.time()) + 300}, key, algorithm="RS256"
        )

    assert v.validate(tok("apps-ui-device", ["apps-ui", "account"]))["azp"] == "apps-ui-device"
    assert v.validate(tok("apps-ui-spa"))["azp"] == "apps-ui-spa"
    with pytest.raises(TokenVerificationError):
        v.validate(tok("grafana"))
    empty = JWTValidator("https://unused.example.test/certs", issuer, "", [])
    empty._jwks.get_signing_key_from_jwt = lambda _t: _Key()  # type: ignore[method-assign]
    with pytest.raises(TokenVerificationError):
        empty.validate(tok("apps-ui-spa"))


async def test_bearer_passthrough_over_http(auth_on, monkeypatch):
    """A token on the MCP HTTP request authenticates the call and reaches apps-api.

    Runs the real Streamable HTTP app so header handling is the production
    path; the in-memory client above never sends HTTP headers at all.
    """
    import httpx
    from fastmcp.utilities.tests import asgi_client

    from nebari_apps_mcp import client as mcp_client

    seen: list[str] = []
    inner = mcp_client.transport

    class Capture(httpx.AsyncBaseTransport):
        async def handle_async_request(self, request: httpx.Request) -> httpx.Response:
            seen.append(request.headers.get("authorization", ""))
            return await inner.handle_async_request(request)

    monkeypatch.setattr(mcp_client, "transport", Capture())

    async with asgi_client(mcp, auth="good-token") as client:
        caps = (await client.call_tool("describe_cluster", {})).data
        assert "inline" in caps["sourceTypes"]
    assert seen and all(h == "Bearer good-token" for h in seen)

    async with asgi_client(mcp, auth="forged-token") as client:
        with pytest.raises(ToolError, match=r"token rejected .*sign in"):
            await client.call_tool("describe_cluster", {})
