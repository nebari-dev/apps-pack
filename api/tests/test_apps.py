from __future__ import annotations

import io
import zipfile

import pytest


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


def test_allowed_namespaces_restricts_managed_namespaces(client, monkeypatch):
    """APPS_NAMESPACES wins over the managed-namespace label: even a managed
    namespace (team-a) is rejected when it is not in the allowlist.
    """
    from nebari_apps_api.config import settings

    monkeypatch.setattr(settings, "allowed_namespaces", ["apps"])

    assert client.post("/api/v1/apps", json=make_app_body()).status_code == 201
    resp = client.post("/api/v1/apps", json=make_app_body(name="other", namespace="team-a"))
    assert resp.status_code == 403

    caps = client.get("/api/v1/capabilities").json()
    assert caps["namespaces"] == ["apps"]


def test_reserved_namespaces_never_offered(client, store):
    """The nebari-operator rejects apps in "default" and kube-* namespaces, so
    the API filters them out even when they carry the managed label.
    """
    store.namespaces = ["apps", "default", "kube-system"]

    caps = client.get("/api/v1/capabilities").json()
    assert caps["namespaces"] == ["apps"]

    resp = client.post("/api/v1/apps", json=make_app_body(namespace="default"))
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


def test_start_wakes_an_idle_app(client, store):
    body = make_app_body()
    body["runtime"] = {"replicas": 3, "idleTimeoutMinutes": 15}
    client.post("/api/v1/apps", json=body)
    cr = store.apps[("apps", "docs-site")]
    cr["status"] = {"phase": "Idle", "lastActivityTime": "2026-10-20T10:00:00Z"}
    assert client.get("/api/v1/apps/apps/docs-site").json()["status"]["lastActivityTime"] == "2026-10-20T10:00:00Z"

    resp = client.post("/api/v1/apps/apps/docs-site/start")
    assert resp.status_code == 200
    cr = store.apps[("apps", "docs-site")]
    assert cr["spec"]["runtime"]["replicas"] == 3, "waking keeps the desired replicas"
    stamp = cr["metadata"]["annotations"]["apps.nebari.dev/wake-requested-at"]
    assert stamp.endswith("Z") and "T" in stamp


def test_idle_settings_round_trip(client, store):
    body = make_app_body()
    body["runtime"] = {"keepAlive": True, "idleTimeoutMinutes": 60}
    assert client.post("/api/v1/apps", json=body).status_code == 201
    runtime = store.apps[("apps", "docs-site")]["spec"]["runtime"]
    assert runtime["keepAlive"] is True and runtime["idleTimeoutMinutes"] == 60
    resp = client.patch(
        "/api/v1/apps/apps/docs-site", json={"runtime": {"keepAlive": False, "idleTimeoutMinutes": None}}
    )
    assert resp.status_code == 200
    runtime = store.apps[("apps", "docs-site")]["spec"]["runtime"]
    assert "idleTimeoutMinutes" not in runtime


@pytest.mark.parametrize("minutes", [0, 4, 43201])
def test_idle_timeout_bounds(client, minutes):
    body = make_app_body()
    body["runtime"] = {"idleTimeoutMinutes": minutes}
    assert client.post("/api/v1/apps", json=body).status_code == 422


def test_patch_and_delete(client, store):
    client.post("/api/v1/apps", json=make_app_body())
    resp = client.patch("/api/v1/apps/apps/docs-site", json={"displayName": "Renamed"})
    assert resp.status_code == 200
    assert resp.json()["displayName"] == "Renamed"

    assert client.delete("/api/v1/apps/apps/docs-site").status_code == 204
    assert client.get("/api/v1/apps/apps/docs-site").status_code == 404


def test_restart(client, store):
    client.post("/api/v1/apps", json=make_app_body())
    resp = client.post("/api/v1/apps/apps/docs-site/restart")
    assert resp.status_code == 200
    assert ("apps", "docs-site") in store.restarted


def test_restart_missing_app(client):
    assert client.post("/api/v1/apps/apps/nope/restart").status_code == 404


def test_metrics(client):
    client.post("/api/v1/apps", json=make_app_body())
    resp = client.get("/api/v1/apps/apps/docs-site/metrics")
    assert resp.status_code == 200
    body = resp.json()
    assert body["available"] is True
    assert body["pods"][0]["cpu"] == "12m"


def test_cluster_metrics(client):
    client.post("/api/v1/apps", json=make_app_body())
    client.post("/api/v1/apps", json=make_app_body(name="two", namespace="team-a"))
    resp = client.get("/api/v1/analytics/metrics")
    assert resp.status_code == 200
    body = resp.json()
    assert body["usageAvailable"] is True
    assert len(body["apps"]) == 2
    assert body["apps"][0]["cpu"] == 12
    assert body["apps"][0]["restarts"] == 1
    assert {n["namespace"] for n in body["byNamespace"]} == {"apps", "team-a"}


def test_cluster_metrics_usage_unavailable(client, store):
    store.metrics_available = False
    client.post("/api/v1/apps", json=make_app_body())
    resp = client.get("/api/v1/analytics/metrics")
    assert resp.status_code == 200
    body = resp.json()
    assert body["usageAvailable"] is False
    # restart counts still populate from pod status
    assert body["apps"][0]["restarts"] == 1
    assert body["apps"][0]["cpu"] == 0


def test_metrics_unavailable(client, store):
    store.metrics_available = False
    client.post("/api/v1/apps", json=make_app_body())
    resp = client.get("/api/v1/apps/apps/docs-site/metrics")
    assert resp.status_code == 200
    assert resp.json() == {"available": False, "pods": []}


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
    assert caps["idleTimeoutMinutes"] == 0
    config = client.get("/api/v1/config").json()
    assert config["authEnabled"] is False


def test_version(client, monkeypatch):
    from nebari_apps_api import __version__
    from nebari_apps_api.config import settings

    monkeypatch.setattr(settings, "build", "sha-abc1234")
    assert client.get("/api/v1/version").json() == {"version": __version__, "build": "sha-abc1234"}
    config = client.get("/api/v1/config").json()
    assert (config["version"], config["build"]) == (__version__, "sha-abc1234")


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
        '{"name": "evil", "namespace": "apps", "displayName": "Evil", "access": {"public": true, "subdomain": "evil"}}'
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


def test_upload_pixi_zip(client, store):
    manifest = (
        '{"name": "py-app", "namespace": "apps", "displayName": "Py App",'
        ' "runtime": {"pixiTask": "start"},'
        ' "access": {"public": true, "subdomain": "py-app"}}'
    )
    data = _zip_bytes(
        {
            "app/pixi.toml": '[project]\nname = "py-app"',
            "app/main.py": "print('hi')",
            "app/pkg/util.py": "X = 1",
        }
    )
    resp = client.post(
        "/api/v1/apps/upload",
        data={"manifest": manifest},
        files={"file": ("app.zip", data, "application/zip")},
    )
    assert resp.status_code == 201, resp.text
    cr = store.apps[("apps", "py-app")]
    assert cr["spec"]["runtime"]["pixiTask"] == "start"
    files = cr["spec"]["source"]["inline"]["files"]
    # single top-level dir is flattened; no index.html required for pixi apps
    assert "pixi.toml" in files
    assert files["pkg/util.py"] == "X = 1"


def test_upload_pixi_requires_manifest(client):
    manifest = (
        '{"name": "no-pixi", "namespace": "apps", "displayName": "NoPixi",'
        ' "runtime": {"pixiTask": "start"},'
        ' "access": {"public": true, "subdomain": "no-pixi"}}'
    )
    data = _zip_bytes({"main.py": "print('hi')"})
    resp = client.post(
        "/api/v1/apps/upload",
        data={"manifest": manifest},
        files={"file": ("app.zip", data, "application/zip")},
    )
    assert resp.status_code == 400
    assert "pixi.toml" in resp.json()["detail"]


def test_upload_pixi_rejects_single_html(client):
    manifest = (
        '{"name": "html-pixi", "namespace": "apps", "displayName": "HtmlPixi",'
        ' "runtime": {"pixiTask": "start"},'
        ' "access": {"public": true, "subdomain": "html-pixi"}}'
    )
    resp = client.post(
        "/api/v1/apps/upload",
        data={"manifest": manifest},
        files={"file": ("page.html", b"<h1>x</h1>", "text/html")},
    )
    assert resp.status_code == 400
    assert "zip" in resp.json()["detail"]


def test_create_pixi_app_json(client, store):
    body = {
        "name": "py-json",
        "namespace": "apps",
        "displayName": "Py JSON",
        "source": {
            "type": "inline",
            "inline": {"files": {"pixi.toml": "[project]", "main.py": "print(1)"}},
        },
        "runtime": {"pixiTask": "serve"},
        "access": {"public": True, "subdomain": "py-json"},
    }
    resp = client.post("/api/v1/apps", json=body)
    assert resp.status_code == 201, resp.text
    assert store.apps[("apps", "py-json")]["spec"]["runtime"]["pixiTask"] == "serve"


def test_create_pixi_inline_requires_manifest(client):
    body = {
        "name": "py-bad",
        "namespace": "apps",
        "displayName": "Py Bad",
        "source": {"type": "inline", "inline": {"files": {"main.py": "print(1)"}}},
        "runtime": {"pixiTask": "serve"},
        "access": {"public": True, "subdomain": "py-bad"},
    }
    resp = client.post("/api/v1/apps", json=body)
    assert resp.status_code == 422
    assert "pixi.toml" in resp.json()["detail"]


def test_upload_rejects_binary(client):
    manifest = (
        '{"name": "bin", "namespace": "apps", "displayName": "Bin", "access": {"public": true, "subdomain": "bin"}}'
    )
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


def test_landing_page_defaults_to_cluster_setting(client, store):
    resp = client.post("/api/v1/apps", json=make_app_body())
    assert resp.status_code == 201, resp.text
    assert resp.json()["landingPage"] is None
    assert "landingPage" not in store.apps[("apps", "docs-site")]["spec"]


def test_landing_page_opt_in_and_out(client, store):
    body = make_app_body() | {"landingPage": {"enabled": True}}
    resp = client.post("/api/v1/apps", json=body)
    assert resp.status_code == 201, resp.text
    assert resp.json()["landingPage"] == {"enabled": True}
    assert store.apps[("apps", "docs-site")]["spec"]["landingPage"] == {"enabled": True}

    # An explicit false must survive the CR tidy-up (it is not "empty").
    resp = client.patch("/api/v1/apps/apps/docs-site", json={"landingPage": {"enabled": False}})
    assert resp.status_code == 200, resp.text
    assert resp.json()["landingPage"] == {"enabled": False}
    assert store.apps[("apps", "docs-site")]["spec"]["landingPage"] == {"enabled": False}

    # {} clears the override so the cluster default applies again.
    resp = client.patch("/api/v1/apps/apps/docs-site", json={"landingPage": {}})
    assert resp.status_code == 200, resp.text
    assert resp.json()["landingPage"] is None
    assert "landingPage" not in store.apps[("apps", "docs-site")]["spec"]


def test_access_users_is_refused(client, store):
    """The users list was removed from access: a client still sending it gets a 422, not an
    App open to more people than it asked for.
    """
    import json

    body = make_app_body()
    body["access"]["users"] = ["alice"]
    assert client.post("/api/v1/apps", json=body).status_code == 422

    manifest = {k: v for k, v in body.items() if k != "source"}
    resp = client.post(
        "/api/v1/apps/upload",
        data={"manifest": json.dumps(manifest)},
        files={"file": ("index.html", b"<h1>hi</h1>", "text/html")},
    )
    assert resp.status_code == 422
    assert store.apps == {}

    assert client.post("/api/v1/apps", json=make_app_body()).status_code == 201
    resp = client.patch(
        "/api/v1/apps/apps/docs-site",
        json={"access": {"public": False, "users": ["alice"], "subdomain": "docs-site"}},
    )
    assert resp.status_code == 422
    assert "users" not in store.apps[("apps", "docs-site")]["spec"]["access"]


@pytest.mark.parametrize("entry", ["a,b", " ", ""])
def test_access_group_entries_must_be_single_names(client, store, entry):
    field = "groups"
    body = make_app_body()
    body["access"][field] = [entry]
    resp = client.post("/api/v1/apps", json=body)
    assert resp.status_code == 422
    assert f"access.{field}" in resp.json()["detail"]
    assert store.apps == {}
    assert client.post("/api/v1/apps", json=make_app_body()).status_code == 201
    resp = client.patch(
        "/api/v1/apps/apps/docs-site",
        json={"access": {"public": False, field: [entry], "subdomain": "docs-site"}},
    )
    assert resp.status_code == 422


def test_cr_with_users_still_readable(client, store):
    """A CR stored before the users list was removed from access must not break reads; the
    field is not returned.
    """
    assert client.post("/api/v1/apps", json=make_app_body()).status_code == 201
    store.apps[("apps", "docs-site")]["spec"]["access"]["users"] = ["alice"]
    resp = client.get("/api/v1/apps/apps/docs-site")
    assert resp.status_code == 200
    assert "users" not in resp.json()["access"]
    assert client.get("/api/v1/apps").status_code == 200


def test_replicas_capped(client):
    body = make_app_body()
    body["runtime"] = {"replicas": 11}
    assert client.post("/api/v1/apps", json=body).status_code == 422
    body["runtime"] = {"replicas": 10}
    assert client.post("/api/v1/apps", json=body).status_code == 201
    assert client.patch("/api/v1/apps/apps/docs-site", json={"runtime": {"replicas": 50}}).status_code == 422
