"""MCP tool tests run against the *real* apps-api, in process.

The chain under test: MCP tool -> httpx (ASGITransport) -> apps-api routes ->
an in-memory AppStore. Only the cluster is faked.
"""

from __future__ import annotations

import copy
from typing import Any

import httpx
import pytest

from nebari_apps_api.config import settings as api_settings
from nebari_apps_api.k8s import ConflictError, NotFoundError
from nebari_apps_api.main import create_app

from nebari_apps_mcp import client as mcp_client
from nebari_apps_mcp.config import settings as mcp_settings


class FakeStore:
    """In-memory AppStore double (mirrors api/tests/conftest.py)."""

    def __init__(self) -> None:
        self.apps: dict[tuple[str, str], dict[str, Any]] = {}
        self.namespaces = ["apps", "team-a"]
        self.logs = "hello from pod\n"

    def list_apps(self, namespace: str | None) -> list[dict[str, Any]]:
        return [
            copy.deepcopy(cr)
            for (ns, _), cr in sorted(self.apps.items())
            if namespace is None or ns == namespace
        ]

    def get_app(self, namespace: str, name: str) -> dict[str, Any]:
        try:
            return copy.deepcopy(self.apps[(namespace, name)])
        except KeyError:
            raise NotFoundError(f"{namespace}/{name}") from None

    def create_app(self, namespace: str, body: dict[str, Any]) -> dict[str, Any]:
        name = body["metadata"]["name"]
        if (namespace, name) in self.apps:
            raise ConflictError(name)
        body.setdefault("metadata", {})["creationTimestamp"] = "2026-07-15T00:00:00Z"
        self.apps[(namespace, name)] = copy.deepcopy(body)
        return copy.deepcopy(body)

    def replace_app(self, namespace: str, name: str, body: dict[str, Any]) -> dict[str, Any]:
        if (namespace, name) not in self.apps:
            raise NotFoundError(f"{namespace}/{name}")
        self.apps[(namespace, name)] = copy.deepcopy(body)
        return copy.deepcopy(body)

    def delete_app(self, namespace: str, name: str) -> None:
        if (namespace, name) not in self.apps:
            raise NotFoundError(f"{namespace}/{name}")
        del self.apps[(namespace, name)]

    def list_managed_namespaces(self) -> list[str]:
        return list(self.namespaces)

    def pod_logs(self, namespace: str, app_name: str, lines: int, container: str | None) -> str:
        return self.logs

    def app_events(self, namespace: str, app_name: str) -> list[dict[str, Any]]:
        return []


@pytest.fixture
def store() -> FakeStore:
    return FakeStore()


@pytest.fixture(autouse=True)
def wire_api(store: FakeStore, monkeypatch):
    """Point the MCP client at an in-process apps-api with auth disabled."""
    monkeypatch.setattr(api_settings, "auth_enabled", False)
    monkeypatch.setattr(mcp_settings, "auth_enabled", False)
    monkeypatch.setattr(mcp_settings, "api_url", "http://apps-api.test")
    monkeypatch.setattr(mcp_client, "transport", httpx.ASGITransport(app=create_app(store)))
    yield
    monkeypatch.setattr(mcp_client, "transport", None)
