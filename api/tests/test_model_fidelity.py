"""Edits through the API keep what other producers (kubectl, GitOps) wrote."""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from nebari_apps_api.auth import User, current_user
from nebari_apps_api.config import settings
from nebari_apps_api.main import create_app

from .test_apps import make_app_body

URL = "/api/v1/apps/apps/docs-site"

KUBECTL_RUNTIME = {
    "replicas": 2,
    "keepAlive": True,
    "pixiTask": "",
    "env": [
        {"name": "LOG_LEVEL", "value": "info"},
        {"name": "TOKEN", "valueFrom": {"configMapKeyRef": {"name": "site", "key": "token"}}},
    ],
    "resources": {
        "requests": {"cpu": "100m", "memory": "128Mi", "ephemeral-storage": "1Gi"},
        "limits": {"memory": "512Mi", "nvidia.com/gpu": "1"},
    },
}


@pytest.fixture
def kubectl_app(client, store):
    """An App created through the API, then edited with kubectl. Returns a
    reader for the stored CR (writes replace it).
    """
    assert client.post("/api/v1/apps", json=make_app_body()).status_code == 201
    runtime = {k: v for k, v in KUBECTL_RUNTIME.items() if v != ""}
    store.apps[("apps", "docs-site")]["spec"]["runtime"] = runtime
    return lambda: store.apps[("apps", "docs-site")]


def test_get_returns_crd_only_fields(client, kubectl_app):
    runtime = client.get(URL).json()["runtime"]
    assert runtime["keepAlive"] is True
    assert runtime["env"][1]["valueFrom"] == {"configMapKeyRef": {"name": "site", "key": "token"}}
    assert runtime["resources"]["limits"]["nvidia.com/gpu"] == "1"


def test_patch_display_name_keeps_runtime(client, kubectl_app):
    before = dict(kubectl_app()["spec"]["runtime"])
    assert client.patch(URL, json={"displayName": "Renamed"}).status_code == 200
    assert kubectl_app()["spec"]["runtime"] == before


def test_patch_runtime_merges_fields(client, kubectl_app):
    resp = client.patch(URL, json={"runtime": {"replicas": 3}})
    assert resp.status_code == 200, resp.text
    runtime = kubectl_app()["spec"]["runtime"]
    assert runtime["replicas"] == 3
    assert runtime["keepAlive"] is True
    assert runtime["env"][1]["valueFrom"]["configMapKeyRef"]["key"] == "token"
    assert runtime["resources"]["requests"]["ephemeral-storage"] == "1Gi"


def test_ui_round_trip_keeps_everything(client, kubectl_app):
    """The UI edits by sending back the runtime it fetched."""
    runtime = client.get(URL).json()["runtime"]
    runtime["env"][0]["value"] = "debug"
    assert client.patch(URL, json={"runtime": runtime}).status_code == 200
    stored = kubectl_app()["spec"]["runtime"]
    assert stored["env"][0] == {"name": "LOG_LEVEL", "value": "debug"}
    assert stored["env"][1] == {"name": "TOKEN", "valueFrom": {"configMapKeyRef": {"name": "site", "key": "token"}}}
    assert stored["keepAlive"] is True
    assert stored["resources"]["limits"]["nvidia.com/gpu"] == "1"


def test_runtime_edit_of_an_app_with_a_stored_secret_ref_must_drop_it(client, store, kubectl_app):
    """An App written with kubectl before secretKeyRef was refused: an edit that
    leaves runtime alone still works, a runtime edit must remove the reference.
    """
    env = [
        {"name": "LOG_LEVEL", "value": "info"},
        {"name": "TOKEN", "valueFrom": {"secretKeyRef": {"name": "site", "key": "token"}}},
    ]
    kubectl_app()["spec"]["runtime"]["env"] = env
    assert client.patch(URL, json={"displayName": "Renamed"}).status_code == 200
    assert client.patch(URL, json={"runtime": {"replicas": 3}}).status_code == 422
    assert client.patch(URL, json={"runtime": {"env": [env[0]]}}).status_code == 200


def test_patch_can_clear_a_runtime_field(client, kubectl_app):
    assert client.patch(URL, json={"runtime": {"env": []}}).status_code == 200
    assert "env" not in kubectl_app()["spec"]["runtime"]
    assert kubectl_app()["spec"]["runtime"]["replicas"] == 2


def test_inline_files_over_the_cap_are_413(client, monkeypatch):
    monkeypatch.setattr(settings, "max_upload_bytes", 1000)
    body = make_app_body()
    body["source"]["inline"]["files"] = {"index.html": "x" * 600, "app.js": "y" * 600}
    resp = client.post("/api/v1/apps", json=body)
    assert resp.status_code == 413, resp.text
    assert "1000-byte cap" in resp.json()["detail"]

    assert client.post("/api/v1/apps", json=make_app_body()).status_code == 201
    big = {"type": "inline", "inline": {"files": {"index.html": "z" * 1001}}}
    assert client.patch(URL, json={"source": big}).status_code == 413


def test_restart_a_stopped_app_is_409(client, store):
    client.post("/api/v1/apps", json=make_app_body())
    assert client.post(f"{URL}/stop").status_code == 200
    resp = client.post(f"{URL}/restart")
    assert resp.status_code == 409
    assert store.restarted == []
    client.post(f"{URL}/start")
    assert client.post(f"{URL}/restart").status_code == 200


def test_email_style_owner(store, monkeypatch):
    monkeypatch.setattr(settings, "auth_enabled", True)
    app = create_app(store)
    app.dependency_overrides[current_user] = lambda: User(username="a@b.c", groups=[])
    client = TestClient(app)
    assert client.post("/api/v1/apps", json=make_app_body()).status_code == 201
    cr = store.apps[("apps", "docs-site")]
    assert cr["spec"]["owner"] == "a@b.c"
    assert "apps.nebari.dev/owner" not in cr["metadata"]["labels"]
    # spec.owner alone makes them the owner.
    assert client.get(URL).status_code == 200
    assert client.patch(URL, json={"displayName": "Mine"}).status_code == 200


def test_patch_null_resources_clears_them(client, kubectl_app):
    assert client.patch(URL, json={"runtime": {"resources": None}}).status_code == 200
    assert "resources" not in kubectl_app()["spec"]["runtime"]
    assert kubectl_app()["spec"]["runtime"]["keepAlive"] is True
