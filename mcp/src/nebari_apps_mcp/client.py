"""Thin async client for apps-api.

All MCP tools go through here: one place for the base URL, bearer handling,
and error shaping. Tests swap the transport for an in-process ASGI app.
"""

from __future__ import annotations

from typing import Any

import httpx

from .config import settings

# Overridable for tests (httpx.ASGITransport pointed at the real apps-api).
transport: httpx.AsyncBaseTransport | None = None


class ApiError(Exception):
    def __init__(self, status: int, detail: str) -> None:
        super().__init__(f"apps-api returned {status}: {detail}")
        self.status = status
        self.detail = detail


class ApiClient:
    def __init__(self, authorization: str = "") -> None:
        headers = {"Authorization": authorization} if authorization else {}
        self._client = httpx.AsyncClient(
            base_url=f"{settings.api_url.rstrip('/')}/api/v1",
            headers=headers,
            timeout=30,
            transport=transport,
        )

    async def __aenter__(self) -> "ApiClient":
        return self

    async def __aexit__(self, *exc: object) -> None:
        await self._client.aclose()

    async def request(self, method: str, path: str, **kwargs: Any) -> Any:
        resp = await self._client.request(method, path, **kwargs)
        if resp.status_code == 204:
            return None
        body: Any
        try:
            body = resp.json()
        except ValueError:
            body = resp.text
        if resp.is_error:
            detail = body.get("detail", body) if isinstance(body, dict) else body
            raise ApiError(resp.status_code, str(detail))
        return body

    async def get(self, path: str, **kwargs: Any) -> Any:
        return await self.request("GET", path, **kwargs)

    async def post(self, path: str, **kwargs: Any) -> Any:
        return await self.request("POST", path, **kwargs)

    async def patch(self, path: str, **kwargs: Any) -> Any:
        return await self.request("PATCH", path, **kwargs)

    async def delete(self, path: str, **kwargs: Any) -> Any:
        return await self.request("DELETE", path, **kwargs)
