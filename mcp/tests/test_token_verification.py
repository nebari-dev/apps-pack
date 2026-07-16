"""The middleware must reject unverified callers on every tool but authenticate."""

from __future__ import annotations

import time

import pytest

from fastmcp import Client
from fastmcp.exceptions import ToolError

from nebari_apps_mcp import auth as auth_mod
from nebari_apps_mcp.auth import TokenState, TokenVerificationError
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
    auth_mod.auth._sessions.clear()
    yield
    auth_mod.auth._sessions.clear()


def seed_session_token(token: str) -> None:
    """Simulate a completed device-flow login for the in-memory client session."""
    state = TokenState(access_token=token, expires_at=time.time() + 300)
    # The in-memory transport has its own session id; seed every session the
    # test client might use by patching state lookup to a shared entry.
    auth_mod.auth._sessions.clear()
    auth_mod.auth._sessions["shared"] = state
    original = auth_mod.auth.state
    auth_mod.auth.state = lambda session_id: auth_mod.auth._sessions["shared"]  # type: ignore[method-assign]
    seed_session_token.restore = lambda: setattr(auth_mod.auth, "state", original)  # type: ignore[attr-defined]


async def test_tools_rejected_without_token(auth_on):
    async with Client(mcp) as client:
        with pytest.raises(ToolError, match="authenticate"):
            await client.call_tool("describe_cluster", {})
        with pytest.raises(ToolError, match="authenticate"):
            await client.call_tool("list_apps", {})


async def test_authenticate_still_callable_without_token(auth_on, monkeypatch):
    # No issuer configured -> authenticate reports unavailable rather than 401.
    monkeypatch.setattr(mcp_settings, "oidc_issuer", "")
    async with Client(mcp) as client:
        result = (await client.call_tool("authenticate", {})).data
        assert result["status"] == "unavailable"


async def test_valid_session_token_passes(auth_on):
    seed_session_token("good-token")
    try:
        async with Client(mcp) as client:
            caps = (await client.call_tool("describe_cluster", {})).data
            assert "inline" in caps["sourceTypes"]
    finally:
        seed_session_token.restore()  # type: ignore[attr-defined]


async def test_forged_session_token_rejected(auth_on):
    seed_session_token("forged-token")
    try:
        async with Client(mcp) as client:
            with pytest.raises(ToolError, match="token rejected"):
                await client.call_tool("describe_cluster", {})
    finally:
        seed_session_token.restore()  # type: ignore[attr-defined]


async def test_auth_disabled_skips_verification():
    # The default fixtures run with auth disabled; no token, tools work.
    async with Client(mcp) as client:
        caps = (await client.call_tool("describe_cluster", {})).data
        assert "namespaces" in caps
