"""Subdomains are unique across all Apps and fixed after launch."""

from __future__ import annotations

from .test_apps import make_app_body


def with_subdomain(name: str, namespace: str, sub: str) -> dict:
    body = make_app_body(name, namespace)
    body["access"]["subdomain"] = sub
    return body


def test_taken_subdomain_is_409_before_create(client, store):
    assert client.post("/api/v1/apps", json=with_subdomain("first", "apps", "shared")).status_code == 201
    resp = client.post("/api/v1/apps", json=with_subdomain("second", "team-a", "shared"))
    assert resp.status_code == 409
    assert "subdomain 'shared'" in resp.json()["detail"]
    assert ("team-a", "second") not in store.apps


def test_taken_subdomain_on_upload_is_409(client, store):
    import json

    assert client.post("/api/v1/apps", json=with_subdomain("first", "apps", "shared")).status_code == 201
    manifest = {k: v for k, v in with_subdomain("second", "apps", "shared").items() if k != "source"}
    resp = client.post(
        "/api/v1/apps/upload",
        data={"manifest": json.dumps(manifest)},
        files={"file": ("index.html", b"<h1>x</h1>", "text/html")},
    )
    assert resp.status_code == 409


def test_same_name_still_reports_name_conflict(client):
    assert client.post("/api/v1/apps", json=make_app_body()).status_code == 201
    resp = client.post("/api/v1/apps", json=make_app_body())
    assert resp.status_code == 409
    assert "already exists" in resp.json()["detail"]


def test_label_written(client, store):
    client.post("/api/v1/apps", json=with_subdomain("first", "apps", "shared"))
    assert store.apps[("apps", "first")]["metadata"]["labels"]["apps.nebari.dev/subdomain"] == "shared"


def test_subdomain_immutable_on_patch(client, store):
    client.post("/api/v1/apps", json=with_subdomain("first", "apps", "shared"))
    resp = client.patch("/api/v1/apps/apps/first", json={"access": {"public": True, "subdomain": "moved"}})
    assert resp.status_code == 422
    resp = client.patch("/api/v1/apps/apps/first", json={"access": {"public": False, "subdomain": "shared"}})
    assert resp.status_code == 200


def test_subdomain_length_and_shape(client):
    assert client.post("/api/v1/apps", json=with_subdomain("a", "apps", "x" * 64)).status_code == 422
    assert client.post("/api/v1/apps", json=with_subdomain("b", "apps", "Bad_Sub")).status_code == 422
    assert client.post("/api/v1/apps", json=with_subdomain("c", "apps", "x" * 63)).status_code == 201
