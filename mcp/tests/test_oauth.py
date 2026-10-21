"""MCP OAuth at the HTTP layer: protected resource metadata, 401 challenges, bearer tokens.

These run the real Streamable HTTP app (auth middleware included) in process.
Nothing is keyed on MCP sessions, so a sessionless 2026-07-28 request and a
handshake-era session authenticate the same way: by the token on each request.
"""

from __future__ import annotations

import json
import time
from collections.abc import AsyncIterator, Iterator
from typing import Any

import jwt
import pytest
from cryptography.hazmat.primitives.asymmetric import rsa
from fastmcp.server.auth import RemoteAuthProvider
from fastmcp.utilities.tests import ASGIServer, asgi_server

from nebari_apps_mcp import auth as auth_mod
from nebari_apps_mcp.auth import JWTValidator, TokenVerificationError, build_auth_provider
from nebari_apps_mcp.config import settings as mcp_settings
from nebari_apps_mcp.server import mcp

ISSUER = "https://keycloak.example.test/realms/nebari"
PUBLIC_URL = "https://apps.example.test"
METADATA_PATH = "/.well-known/oauth-protected-resource/mcp"
MODERN = "2026-07-28"
KEY = rsa.generate_private_key(public_exponent=65537, key_size=2048)
ALLOWED = ["apps-ui-spa", "apps-ui-device", "nebari-apps-mcp"]


class _Key:
    key = KEY.public_key()


def real_validator(allowed: list[str] | None = ALLOWED) -> JWTValidator:
    """The production validator, with the JWKS fetch replaced by a fixed key."""
    v = JWTValidator("https://unused.example.test/certs", ISSUER, "", allowed)
    v._jwks.get_signing_key_from_jwt = lambda _t: _Key()  # type: ignore[method-assign]
    return v


def token(azp: str = "nebari-apps-mcp", **claims: Any) -> str:
    body = {"iss": ISSUER, "azp": azp, "aud": "account", "sub": "u-1", "exp": int(time.time()) + 300, **claims}
    return jwt.encode(body, KEY, algorithm="RS256")


@pytest.fixture
def oauth(monkeypatch) -> Iterator[None]:
    monkeypatch.setattr(mcp_settings, "auth_enabled", True)
    monkeypatch.setattr(mcp_settings, "oidc_issuer", ISSUER)
    monkeypatch.setattr(mcp_settings, "public_url", PUBLIC_URL)
    monkeypatch.setattr(auth_mod, "_validator", real_validator())
    mcp.auth = build_auth_provider()
    yield
    mcp.auth = None


@pytest.fixture
async def server(oauth) -> AsyncIterator[ASGIServer]:
    async with asgi_server(mcp) as running:
        yield running


def modern_call(tool: str, arguments: dict[str, Any] | None = None, request_id: int = 1) -> dict[str, Any]:
    """A 2026-07-28 tools/call: no initialize, no session, the envelope in _meta."""
    return {
        "jsonrpc": "2.0",
        "id": request_id,
        "method": "tools/call",
        "params": {
            "name": tool,
            "arguments": arguments or {},
            "_meta": {
                "io.modelcontextprotocol/protocolVersion": MODERN,
                "io.modelcontextprotocol/clientCapabilities": {},
                "io.modelcontextprotocol/clientInfo": {"name": "test", "version": "0"},
            },
        },
    }


def modern_headers(tool: str, bearer: str | None) -> dict[str, str]:
    headers = {
        "Accept": "application/json, text/event-stream",
        "Content-Type": "application/json",
        "MCP-Protocol-Version": MODERN,
        "Mcp-Method": "tools/call",
        "Mcp-Name": tool,
    }
    if bearer is not None:
        headers["Authorization"] = f"Bearer {bearer}"
    return headers


def jsonrpc_result(text: str) -> dict[str, Any]:
    """The JSON-RPC message from a JSON or SSE response body."""
    if text.lstrip().startswith("{"):
        return dict(json.loads(text))
    data = [line.removeprefix("data:").strip() for line in text.splitlines() if line.startswith("data:")]
    return dict(json.loads(data[-1]))


async def test_protected_resource_metadata(server):
    async with server.http_client() as http:
        resp = await http.get(METADATA_PATH)
    assert resp.status_code == 200
    meta = resp.json()
    assert meta["resource"] == f"{PUBLIC_URL}/mcp"
    assert meta["authorization_servers"] == [ISSUER]
    assert meta["scopes_supported"] == ["openid"]
    assert meta["bearer_methods_supported"] == ["header"]


async def test_missing_token_gets_401_challenge(server):
    async with server.http_client() as http:
        resp = await http.post(
            "/mcp", json=modern_call("describe_cluster"), headers=modern_headers("describe_cluster", None)
        )
    assert resp.status_code == 401
    challenge = resp.headers["www-authenticate"]
    assert challenge.startswith("Bearer")
    assert f'resource_metadata="{PUBLIC_URL}{METADATA_PATH}"' in challenge
    # RFC 6750 §3.1: no error attribute when no credentials were sent.
    assert "error=" not in challenge


@pytest.mark.parametrize(
    "bad",
    [
        "not-a-jwt",
        token(exp=int(time.time()) - 10),  # expired
        token(iss="https://evil.example.test/realms/nebari"),  # wrong issuer
        token(azp="grafana"),  # another realm client: azp/aud binding
    ],
)
async def test_invalid_token_gets_401_invalid_token(server, bad):
    async with server.http_client() as http:
        resp = await http.post(
            "/mcp", json=modern_call("describe_cluster"), headers=modern_headers("describe_cluster", bad)
        )
    assert resp.status_code == 401
    challenge = resp.headers["www-authenticate"]
    assert 'error="invalid_token"' in challenge
    assert f'resource_metadata="{PUBLIC_URL}{METADATA_PATH}"' in challenge


async def test_modern_sessionless_requests_authenticate_per_request(server):
    """Each 2026-07-28 request stands alone; the token on it is all the auth there is."""
    good = token()
    async with server.http_client() as http:
        for request_id in (1, 2):
            resp = await http.post(
                "/mcp",
                json=modern_call("describe_cluster", request_id=request_id),
                headers=modern_headers("describe_cluster", good),
            )
            assert resp.status_code == 200, resp.text
            assert "mcp-session-id" not in resp.headers
            result = jsonrpc_result(resp.text)["result"]
            assert not result.get("isError"), result
            assert "inline" in result["structuredContent"]["sourceTypes"]


async def test_aud_binding_accepts_pack_client_in_aud(server):
    # azp is some other client, but the token names an allowed client as audience.
    bound = token(azp="cli-helper", aud=["nebari-apps-mcp", "account"])
    async with server.http_client() as http:
        resp = await http.post(
            "/mcp", json=modern_call("describe_cluster"), headers=modern_headers("describe_cluster", bound)
        )
    assert resp.status_code == 200, resp.text


async def test_handshake_session_with_bearer(server):
    async with server.client(auth=token()) as client:
        caps = (await client.call_tool("describe_cluster", {})).data
        assert "inline" in caps["sourceTypes"]


async def test_handshake_session_without_token_is_refused(server):
    async with server.http_client() as http:
        resp = await http.post(
            "/mcp",
            json={
                "jsonrpc": "2.0",
                "id": 1,
                "method": "initialize",
                "params": {
                    "protocolVersion": "2025-06-18",
                    "capabilities": {},
                    "clientInfo": {"name": "test", "version": "0"},
                },
            },
            headers={"Accept": "application/json, text/event-stream", "Content-Type": "application/json"},
        )
    assert resp.status_code == 401
    assert "resource_metadata=" in resp.headers["www-authenticate"]


async def test_healthz_needs_no_token(server):
    async with server.http_client() as http:
        assert (await http.get("/healthz")).status_code == 200


def test_provider_shape(oauth):
    provider = mcp.auth
    assert isinstance(provider, RemoteAuthProvider)
    assert [str(s).rstrip("/") for s in provider.authorization_servers] == [ISSUER]


def test_no_provider_when_auth_disabled(monkeypatch):
    monkeypatch.setattr(mcp_settings, "auth_enabled", False)
    assert build_auth_provider() is None


def test_bare_verifier_without_public_url(monkeypatch):
    """Without a public URL there is no metadata to point at, but tokens are still required."""
    monkeypatch.setattr(mcp_settings, "auth_enabled", True)
    monkeypatch.setattr(mcp_settings, "oidc_issuer", ISSUER)
    monkeypatch.setattr(mcp_settings, "public_url", "")
    provider = build_auth_provider()
    assert provider is not None
    assert not isinstance(provider, RemoteAuthProvider)


async def test_verifier_maps_claims(oauth):
    provider = build_auth_provider()
    assert provider is not None
    access = await provider.verify_token(token(scope="openid profile email"))
    assert access is not None
    assert access.client_id == "nebari-apps-mcp"
    assert access.subject == "u-1"
    assert access.scopes == ["openid", "profile", "email"]
    assert await provider.verify_token(token(azp="grafana")) is None


async def test_unconfigured_jwks_fails_closed(monkeypatch):
    monkeypatch.setattr(mcp_settings, "auth_enabled", True)
    monkeypatch.setattr(mcp_settings, "oidc_issuer", "")
    monkeypatch.setattr(mcp_settings, "oidc_jwks_url", "")
    monkeypatch.setattr(mcp_settings, "oidc_issuer_internal", "")
    monkeypatch.setattr(auth_mod, "_validator", None)
    with pytest.raises(TokenVerificationError):
        auth_mod.get_validator()
    provider = build_auth_provider()
    assert provider is not None
    assert await provider.verify_token(token()) is None


async def test_auth_disabled_http_is_anonymous():
    # The default fixtures run with auth disabled and mcp.auth unset.
    assert mcp.auth is None
    async with asgi_server(mcp) as running, running.http_client() as http:
        assert (await http.get(METADATA_PATH)).status_code == 404
        resp = await http.post(
            "/mcp", json=modern_call("describe_cluster"), headers=modern_headers("describe_cluster", None)
        )
    assert resp.status_code == 200, resp.text
