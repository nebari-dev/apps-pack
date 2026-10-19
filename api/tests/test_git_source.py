"""Git source URLs: https only, no credentials, no internal hosts."""

from __future__ import annotations

import pytest

from .test_apps import make_app_body

BAD_URLS = [
    "--upload-pack=touch /tmp/pwned",
    "file:///etc",
    "http://github.com/example/site",
    "ssh://git@github.com/example/site",
    "git@github.com:example/site.git",
    "https://user:token@github.com/example/site",
    "https://token@github.com/example/site",
    "https://localhost/repo",
    "https://127.0.0.1/repo",
    "https://10.0.0.5/repo",
    "https://169.254.169.254/latest",
    "https://[::1]/repo",
    "https://kubernetes.default.svc/api",
    "https://gitea.gitea.svc.cluster.local/repo",
    "https://gitea/repo",
]


def git_body(url: str, ref: str = "main") -> dict:
    body = make_app_body("team-site")
    body["source"] = {"type": "git", "git": {"url": url, "ref": ref}}
    return body


@pytest.mark.parametrize("url", BAD_URLS)
def test_create_rejects_unsafe_git_url(client, store, url):
    resp = client.post("/api/v1/apps", json=git_body(url))
    assert resp.status_code == 422, resp.text
    assert resp.json()["detail"].startswith("source.git:")
    assert store.apps == {}


def test_create_rejects_option_ref(client):
    resp = client.post("/api/v1/apps", json=git_body("https://github.com/example/site", "--upload-pack=x"))
    assert resp.status_code == 422


def test_public_https_accepted(client, store):
    resp = client.post("/api/v1/apps", json=git_body("https://github.com/example/site.git", "v1.0"))
    assert resp.status_code == 201, resp.text


def test_patch_rejects_unsafe_git_url(client, store):
    assert client.post("/api/v1/apps", json=git_body("https://github.com/example/site")).status_code == 201
    resp = client.patch(
        "/api/v1/apps/apps/team-site",
        json={"source": {"type": "git", "git": {"url": "file:///etc"}}},
    )
    assert resp.status_code == 422
    assert store.apps[("apps", "team-site")]["spec"]["source"]["git"]["url"] == "https://github.com/example/site"


def test_existing_cr_with_bad_url_still_readable(client, store):
    assert client.post("/api/v1/apps", json=git_body("https://github.com/example/site")).status_code == 201
    store.apps[("apps", "team-site")]["spec"]["source"]["git"]["url"] = "http://legacy.example/repo"
    assert client.get("/api/v1/apps/apps/team-site").status_code == 200
