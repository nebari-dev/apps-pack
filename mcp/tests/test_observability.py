"""MCP liveness endpoint and request-id propagation to apps-api."""

from __future__ import annotations

import httpx
from starlette.middleware import Middleware
from starlette.testclient import TestClient

from nebari_apps_mcp import client as mcp_client
from nebari_apps_mcp.client import ApiClient
from nebari_apps_mcp.logs import RequestIdMiddleware
from nebari_apps_mcp.server import mcp


def test_healthz_over_http():
    app = mcp.http_app(middleware=[Middleware(RequestIdMiddleware, quiet_paths=["/healthz"])])
    with TestClient(app) as http:
        resp = http.get("/healthz", headers={"X-Request-ID": "probe-1"})
    assert resp.status_code == 200
    assert resp.json() == {"status": "ok"}
    assert resp.headers["x-request-id"] == "probe-1"


async def test_api_client_forwards_request_id(monkeypatch):
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(200, json={}, headers={"X-Request-ID": request.headers.get("x-request-id", "")})

    monkeypatch.setattr(mcp_client, "transport", httpx.MockTransport(handler))
    async with ApiClient("Bearer t", request_id="agent-42") as api:
        await api.get("/capabilities")
    assert seen[0].headers["x-request-id"] == "agent-42"
    assert seen[0].headers["authorization"] == "Bearer t"


async def test_api_client_without_request_id_sends_none(monkeypatch):
    seen: list[httpx.Request] = []
    monkeypatch.setattr(
        mcp_client, "transport", httpx.MockTransport(lambda r: seen.append(r) or httpx.Response(200, json={}))
    )
    async with ApiClient() as api:
        await api.get("/capabilities")
    assert "x-request-id" not in seen[0].headers
