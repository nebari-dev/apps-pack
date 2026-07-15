from __future__ import annotations

import copy
from typing import Any

import pytest
from fastapi.testclient import TestClient

from nebari_apps_api.config import settings
from nebari_apps_api.k8s import ConflictError, NotFoundError
from nebari_apps_api.main import create_app


class FakeStore:
    """In-memory AppStore double."""

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
        return [{"type": "Normal", "reason": "Created", "message": "ok",
                 "kind": "Deployment", "object": f"app-{app_name}", "count": 1,
                 "lastTimestamp": "2026-07-15T00:00:00Z"}]


@pytest.fixture(autouse=True)
def no_auth(monkeypatch):
    monkeypatch.setattr(settings, "auth_enabled", False)


@pytest.fixture
def store() -> FakeStore:
    return FakeStore()


@pytest.fixture
def client(store: FakeStore) -> TestClient:
    return TestClient(create_app(store))
