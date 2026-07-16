from __future__ import annotations

import io
import zipfile


def make_app_body(name: str = "docs-site", namespace: str = "apps") -> dict:
    return {
        "name": name,
        "namespace": namespace,
        "displayName": "Docs Site",
        "source": {"type": "inline", "inline": {"files": {"index.html": "<h1>hi</h1>"}}},
        "access": {"public": True, "subdomain": name},
    }


def test_create_and_get_app(client):
    resp = client.post("/api/v1/apps", json=make_app_body())
    assert resp.status_code == 201, resp.text
    body = resp.json()
    assert body["name"] == "docs-site"
    assert body["source"]["type"] == "inline"
    assert body["status"]["phase"] == "Pending"

    resp = client.get("/api/v1/apps/apps/docs-site")
    assert resp.status_code == 200
    assert resp.json()["displayName"] == "Docs Site"


def test_create_conflict(client):
    assert client.post("/api/v1/apps", json=make_app_body()).status_code == 201
    assert client.post("/api/v1/apps", json=make_app_body()).status_code == 409


def test_create_rejects_unmanaged_namespace(client):
    body = make_app_body(namespace="nope")
    resp = client.post("/api/v1/apps", json=body)
    assert resp.status_code == 403


def test_create_rejects_unknown_source_type(client):
    body = make_app_body()
    body["source"] = {"type": "image", "image": {"repository": "quay.io/x/app"}}
    resp = client.post("/api/v1/apps", json=body)
    assert resp.status_code == 422


def test_create_rejects_missing_source_payload(client):
    body = make_app_body()
    body["source"] = {"type": "git"}
    resp = client.post("/api/v1/apps", json=body)
    assert resp.status_code == 422
    assert "source.git" in resp.json()["detail"]


def test_stop_start(client, store):
    client.post("/api/v1/apps", json=make_app_body())
    resp = client.post("/api/v1/apps/apps/docs-site/stop")
    assert resp.status_code == 200
    assert store.apps[("apps", "docs-site")]["spec"]["runtime"]["replicas"] == 0
    client.post("/api/v1/apps/apps/docs-site/start")
    assert store.apps[("apps", "docs-site")]["spec"]["runtime"]["replicas"] == 1


def test_patch_and_delete(client, store):
    client.post("/api/v1/apps", json=make_app_body())
    resp = client.patch("/api/v1/apps/apps/docs-site", json={"displayName": "Renamed"})
    assert resp.status_code == 200
    assert resp.json()["displayName"] == "Renamed"

    assert client.delete("/api/v1/apps/apps/docs-site").status_code == 204
    assert client.get("/api/v1/apps/apps/docs-site").status_code == 404


def test_logs_and_events(client):
    client.post("/api/v1/apps", json=make_app_body())
    resp = client.get("/api/v1/apps/apps/docs-site/logs")
    assert resp.status_code == 200
    assert "hello" in resp.json()["logs"]
    resp = client.get("/api/v1/apps/apps/docs-site/events")
    assert resp.status_code == 200
    assert resp.json()[0]["reason"] == "Created"


def test_catalogs(client):
    caps = client.get("/api/v1/capabilities").json()
    assert caps["sourceTypes"] == ["git", "inline", "pvc"]
    assert "apps" in caps["namespaces"]
    config = client.get("/api/v1/config").json()
    assert config["authEnabled"] is False


def test_analytics_summary(client):
    client.post("/api/v1/apps", json=make_app_body())
    body = make_app_body(name="two", namespace="team-a")
    body["source"] = {"type": "git", "git": {"url": "https://github.com/example/site"}}
    client.post("/api/v1/apps", json=body)

    summary = client.get("/api/v1/analytics/summary").json()
    assert summary["total"] == 2
    assert summary["bySourceType"] == {"inline": 1, "git": 1}
    assert summary["byNamespace"] == {"apps": 1, "team-a": 1}


def _zip_bytes(files: dict[str, str]) -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        for name, content in files.items():
            zf.writestr(name, content)
    return buf.getvalue()


def test_upload_zip(client, store):
    manifest = (
        '{"name": "uploaded", "namespace": "apps", "displayName": "Uploaded",'
        ' "access": {"public": true, "subdomain": "uploaded"}}'
    )
    data = _zip_bytes({"site/index.html": "<h1>up</h1>", "site/style.css": "body{}"})
    resp = client.post(
        "/api/v1/apps/upload",
        data={"manifest": manifest},
        files={"file": ("site.zip", data, "application/zip")},
    )
    assert resp.status_code == 201, resp.text
    cr = store.apps[("apps", "uploaded")]
    files = cr["spec"]["source"]["inline"]["files"]
    # single top-level dir is flattened
    assert files["index.html"] == "<h1>up</h1>"
    assert files["style.css"] == "body{}"


def test_upload_single_html(client, store):
    manifest = (
        '{"name": "single", "namespace": "apps", "displayName": "Single",'
        ' "access": {"public": true, "subdomain": "single"}}'
    )
    resp = client.post(
        "/api/v1/apps/upload",
        data={"manifest": manifest},
        files={"file": ("page.html", b"<h1>solo</h1>", "text/html")},
    )
    assert resp.status_code == 201, resp.text
    files = store.apps[("apps", "single")]["spec"]["source"]["inline"]["files"]
    assert files == {"index.html": "<h1>solo</h1>"}


def test_upload_rejects_traversal(client):
    manifest = (
        '{"name": "evil", "namespace": "apps", "displayName": "Evil",'
        ' "access": {"public": true, "subdomain": "evil"}}'
    )
    data = _zip_bytes({"../escape.html": "<h1>bad</h1>", "index.html": "<h1>x</h1>"})
    resp = client.post(
        "/api/v1/apps/upload",
        data={"manifest": manifest},
        files={"file": ("site.zip", data, "application/zip")},
    )
    assert resp.status_code == 400


def test_upload_requires_index(client):
    manifest = (
        '{"name": "noindex", "namespace": "apps", "displayName": "NoIndex",'
        ' "access": {"public": true, "subdomain": "noindex"}}'
    )
    data = _zip_bytes({"about.html": "<h1>about</h1>"})
    resp = client.post(
        "/api/v1/apps/upload",
        data={"manifest": manifest},
        files={"file": ("site.zip", data, "application/zip")},
    )
    assert resp.status_code == 400
    assert "index.html" in resp.json()["detail"]


def test_upload_rejects_binary(client):
    manifest = (
        '{"name": "bin", "namespace": "apps", "displayName": "Bin",'
        ' "access": {"public": true, "subdomain": "bin"}}'
    )
    data = _zip_bytes({"index.html": "<h1>x</h1>"})
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        zf.writestr("index.html", "<h1>x</h1>")
        zf.writestr("logo.png", b"\x89PNG\r\n")
    resp = client.post(
        "/api/v1/apps/upload",
        data={"manifest": manifest},
        files={"file": ("site.zip", buf.getvalue(), "application/zip")},
    )
    assert resp.status_code == 400
