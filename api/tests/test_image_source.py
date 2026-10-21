"""Source type image: the registry allowlist and the image source rules.

The matching cases mirror operator/internal/controller/imageref_test.go; the
operator is the boundary, apps-api refuses the same images up front.
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from nebari_apps_api.config import settings
from nebari_apps_api.images import check_image, parse_allowlist, parse_image_ref, registry_allowed
from nebari_apps_api.main import create_app

from .test_apps import make_app_body

DIGEST = "sha256:" + "a" * 64
ALLOW = ["ghcr.io/org", " Docker.io/library/ ", "registry.example.com:5000", "quay.io"]


@pytest.mark.parametrize(
    ("raw", "want"),
    [
        ("nginx:1.27", "docker.io/library/nginx:1.27"),
        ("bitnami/nginx:1.27", "docker.io/bitnami/nginx:1.27"),
        ("docker.io/nginx:1", "docker.io/library/nginx:1"),
        ("index.docker.io/library/nginx:1", "docker.io/library/nginx:1"),
        ("registry-1.docker.io/org/app:v2", "docker.io/org/app:v2"),
        ("GHCR.io/org/app:1.2.3", "ghcr.io/org/app:1.2.3"),
        (f"ghcr.io/org/team/app@{DIGEST}", f"ghcr.io/org/team/app@{DIGEST}"),
        (f"ghcr.io/org/app:1.0@{DIGEST}", f"ghcr.io/org/app:1.0@{DIGEST}"),
        ("localhost:5000/app:dev", "localhost:5000/app:dev"),
        ("registry.example.com:5000/a/b:latest", "registry.example.com:5000/a/b:latest"),
    ],
)
def test_parse_normalizes(raw, want):
    assert str(parse_image_ref(raw)) == want


@pytest.mark.parametrize(
    "raw",
    [
        "",
        " nginx:1",
        "nginx:1\n",
        "nginx",
        "ghcr.io/org/app",
        "localhost:5000/app",
        "ghcr.io/Org/app:1",
        "ghcr.io/org/app:-bad",
        "ghcr.io/org/app@sha256:abc",
        "ghcr.io/org/app@md5:" + "a" * 64,
        "ghcr.io/org//app:1",
        "ghcr.io/org/app:1;rm -rf /",
        "https://ghcr.io/org/app:1",
        "-ghcr.io/org/app:1",
    ],
)
def test_parse_rejects(raw):
    with pytest.raises(ValueError):
        parse_image_ref(raw)


@pytest.mark.parametrize(
    ("raw", "allowed"),
    [
        ("ghcr.io/org/app:1", True),
        ("ghcr.io/org/team/app:1", True),
        ("ghcr.io/org:1", True),
        ("ghcr.io/org-evil/app:1", False),
        ("ghcr.io/organization/app:1", False),
        ("ghcr.io/other/app:1", False),
        ("ghcr.io.evil.com/org/app:1", False),
        ("evil.com/ghcr.io/org/app:1", False),
        ("nginx:1.27", True),
        ("index.docker.io/library/redis:7", True),
        ("bitnami/nginx:1", False),
        ("docker.io/libraryx/nginx:1", False),
        ("registry.example.com:5000/x/y:1", True),
        ("registry.example.com/x/y:1", False),
        ("registry.example.com:50001/x/y:1", False),
        ("quay.io/anyone/app:1", True),
        ("quay.io.example.net/anyone/app:1", False),
        ("sub.quay.io/anyone/app:1", False),
    ],
)
def test_allowlist_matching(raw, allowed):
    allow = parse_allowlist(ALLOW)
    assert allow == ["ghcr.io/org", "docker.io/library", "registry.example.com:5000", "quay.io"]
    assert registry_allowed(parse_image_ref(raw), allow) is allowed


@pytest.mark.parametrize(
    "entry", ["library", "org/app", "ghcr.io/*", "ghcr.io/org/app:1", "ghcr.io/Org", "https://ghcr.io"]
)
def test_allowlist_rejects_bad_entries(entry):
    with pytest.raises(ValueError):
        parse_allowlist([entry])


def test_empty_allowlist_disables_images():
    with pytest.raises(ValueError, match="disabled"):
        check_image("ghcr.io/org/app:1", [])


def test_invalid_allowlist_fails_startup(monkeypatch, store):
    monkeypatch.setattr(settings, "image_registries", ["ghcr.io/*"])
    with pytest.raises(ValueError):
        create_app(store)


@pytest.fixture
def image_client(monkeypatch, store) -> TestClient:
    monkeypatch.setattr(settings, "image_registries", ["ghcr.io/org", "docker.io/library"])
    return TestClient(create_app(store))


def image_body(reference: str = "ghcr.io/org/dash:1.2.3", **image) -> dict:
    body = make_app_body("dash")
    body["source"] = {"type": "image", "image": {"reference": reference, "port": 8501, **image}}
    return body


def test_capabilities_hide_image_when_off(client):
    caps = client.get("/api/v1/capabilities").json()
    assert "image" not in caps["sourceTypes"]
    assert caps["imageRegistries"] == []


def test_capabilities_offer_image_when_allowed(image_client):
    caps = image_client.get("/api/v1/capabilities").json()
    assert "image" in caps["sourceTypes"]
    assert caps["imageRegistries"] == ["ghcr.io/org", "docker.io/library"]


def test_create_image_app(image_client, store):
    body = image_body(command=["streamlit"], args=["run", "app.py"], runAsUser=1000)
    body["secrets"] = {"API_TOKEN": "s3cret"}
    resp = image_client.post("/api/v1/apps", json=body)
    assert resp.status_code == 201, resp.text
    spec = store.apps[("apps", "dash")]["spec"]
    assert spec["source"] == {
        "type": "image",
        "image": {
            "reference": "ghcr.io/org/dash:1.2.3",
            "port": 8501,
            "command": ["streamlit"],
            "args": ["run", "app.py"],
            "runAsUser": 1000,
        },
    }
    assert spec["runtime"]["secretKeys"] == ["API_TOKEN"]
    assert resp.json()["source"]["image"]["port"] == 8501


def test_create_rejected_when_feature_off(client, store):
    resp = client.post("/api/v1/apps", json=image_body())
    assert resp.status_code == 422
    assert "disabled" in resp.json()["detail"]
    assert store.apps == {}


@pytest.mark.parametrize(
    ("body", "detail"),
    [
        (image_body("ghcr.io.evil.com/org/app:1"), "not in the allowed image registries"),
        (image_body("ghcr.io/org-evil/app:1"), "ghcr.io/org-evil/app is not in the allowed"),
        (image_body("bitnami/nginx:1"), "docker.io/bitnami/nginx"),
        (image_body("ghcr.io/org/app"), "tag"),
    ],
)
def test_create_rejects_images_outside_the_allowlist(image_client, store, body, detail):
    resp = image_client.post("/api/v1/apps", json=body)
    assert resp.status_code == 422, resp.text
    assert resp.json()["detail"].startswith("source.image.reference:")
    assert detail in resp.json()["detail"]
    assert store.apps == {}


@pytest.mark.parametrize("port", [80, 8080, 8082, 70000])
def test_create_rejects_bad_ports(image_client, port):
    body = image_body()
    body["source"]["image"]["port"] = port
    assert image_client.post("/api/v1/apps", json=body).status_code == 422


def test_create_rejects_root_uid_and_pixi(image_client):
    assert image_client.post("/api/v1/apps", json=image_body(runAsUser=0)).status_code == 422
    body = image_body()
    body["runtime"] = {"pixiTask": "start"}
    resp = image_client.post("/api/v1/apps", json=body)
    assert resp.status_code == 422
    assert "pixiTask" in resp.json()["detail"]


def test_create_requires_the_image_block(image_client):
    body = make_app_body("dash")
    body["source"] = {"type": "image"}
    assert image_client.post("/api/v1/apps", json=body).status_code == 422


def test_create_rejects_secret_env_refs(image_client):
    body = image_body()
    body["runtime"] = {"env": [{"name": "T", "valueFrom": {"secretKeyRef": {"name": "db", "key": "pw"}}}]}
    resp = image_client.post("/api/v1/apps", json=body)
    assert resp.status_code == 422
    assert "secretKeyRef" in resp.json()["detail"]


def test_patch_checks_the_image(image_client, store):
    assert image_client.post("/api/v1/apps", json=image_body()).status_code == 201
    resp = image_client.patch(
        "/api/v1/apps/apps/dash",
        json={"source": {"type": "image", "image": {"reference": "docker.io/evil/app:1", "port": 8501}}},
    )
    assert resp.status_code == 422
    assert store.apps[("apps", "dash")]["spec"]["source"]["image"]["reference"] == "ghcr.io/org/dash:1.2.3"
    resp = image_client.patch(
        "/api/v1/apps/apps/dash",
        json={"source": {"type": "image", "image": {"reference": "ghcr.io/org/dash:1.2.4", "port": 8502}}},
    )
    assert resp.status_code == 200, resp.text
    assert store.apps[("apps", "dash")]["spec"]["source"]["image"]["port"] == 8502
    resp = image_client.patch("/api/v1/apps/apps/dash", json={"runtime": {"pixiTask": "start"}})
    assert resp.status_code == 422


def test_patch_moves_a_static_app_to_an_image(image_client, store):
    body = make_app_body("site")
    assert image_client.post("/api/v1/apps", json=body).status_code == 201
    resp = image_client.patch(
        "/api/v1/apps/apps/site",
        json={"source": {"type": "image", "image": {"reference": "nginx:1.27", "port": 8081}}},
    )
    assert resp.status_code == 200, resp.text
