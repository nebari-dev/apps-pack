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
        self.ready = True
        self.logs = "hello from pod\n"
        self.restarted: list[tuple[str, str]] = []
        self.metrics_available = True
        # (namespace, secret name) -> key -> value
        self.secrets: dict[tuple[str, str], dict[str, str]] = {}

    def list_apps(self, namespace: str | None) -> list[dict[str, Any]]:
        return [copy.deepcopy(cr) for (ns, _), cr in sorted(self.apps.items()) if namespace is None or ns == namespace]

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
        body["metadata"]["uid"] = f"uid-{namespace}-{name}"
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

    def check_ready(self) -> None:
        if not self.ready:
            raise ConnectionError("apiserver unreachable")

    def list_managed_namespaces(self) -> list[str]:
        return list(self.namespaces)

    def pod_logs(self, namespace: str, app_name: str, lines: int, container: str | None) -> str:
        return self.logs

    def app_events(self, namespace: str, app_name: str) -> list[dict[str, Any]]:
        return []

    def restart_app(self, namespace: str, app_name: str) -> None:
        if (namespace, app_name) not in self.apps:
            raise NotFoundError(f"app-{app_name}")
        self.restarted.append((namespace, app_name))

    def write_secret(
        self, namespace: str, name: str, owner: dict[str, str], labels: dict[str, str], changes: dict[str, str | None]
    ) -> str:
        data = self.secrets.setdefault((namespace, name), {})
        for key, value in changes.items():
            if value is None:
                data.pop(key, None)
            else:
                data[key] = value
        return str(len(data))

    def pod_metrics(self, namespace: str, app_name: str) -> list[dict[str, Any]]:
        if not self.metrics_available:
            raise NotFoundError("metrics.k8s.io not available")
        return [{"name": f"app-{app_name}-abc123", "cpu": "12m", "memory": "34Mi"}]

    def cluster_pod_metrics(self) -> list[dict[str, Any]]:
        if not self.metrics_available:
            raise NotFoundError("metrics.k8s.io not available")
        return [{"namespace": ns, "app": name, "cpu": 12, "memory": 34} for (ns, name) in self.apps]

    def app_restarts(self) -> list[dict[str, Any]]:
        return [{"namespace": ns, "app": name, "restarts": 1} for (ns, name) in self.apps]


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
