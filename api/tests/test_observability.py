"""Request ids on every response and in the logs; readiness that checks dependencies."""

from __future__ import annotations

import logging

import httpx
import pytest
from nebari_apps_api import main
from nebari_apps_api.config import settings


def test_request_id_generated_and_echoed(client):
    resp = client.get("/api/v1/apps")
    rid = resp.headers["x-request-id"]
    assert len(rid) == 32
    assert client.get("/api/v1/apps").headers["x-request-id"] != rid


def test_request_id_from_caller_is_kept(client):
    resp = client.get("/api/v1/apps", headers={"X-Request-ID": "ui-1234.abc"})
    assert resp.headers["x-request-id"] == "ui-1234.abc"


@pytest.mark.parametrize("bad", ["has space", "x" * 129, "line\nbreak", ""])
def test_malformed_request_id_is_replaced(client, bad):
    resp = client.get("/api/v1/apps", headers={"X-Request-ID": bad})
    assert resp.headers["x-request-id"] != bad
    assert len(resp.headers["x-request-id"]) == 32


def test_access_log_carries_request_id(client, caplog):
    with caplog.at_level(logging.INFO, logger="nebari_apps_api.access"):
        client.get("/api/v1/apps", headers={"X-Request-ID": "trace-me"})
    lines = [r.msg for r in caplog.records if isinstance(r.msg, dict) and r.msg.get("event") == "request"]
    assert lines, caplog.records
    assert lines[-1]["request_id"] == "trace-me"
    assert lines[-1]["path"] == "/api/v1/apps"
    assert lines[-1]["status"] == 200


def test_readyz_ok(client):
    resp = client.get("/api/v1/readyz")
    assert resp.status_code == 200
    assert resp.json() == {"status": "ok", "checks": {"kubernetes": "ok"}}


def test_readyz_fails_with_failing_store(client, store):
    store.ready = False
    resp = client.get("/api/v1/readyz")
    assert resp.status_code == 503
    assert resp.json()["checks"] == {"kubernetes": "failed"}
    # Reachable without a token: the reason is logged, not returned.
    assert "unreachable" not in resp.text


def test_readyz_checks_jwks_when_auth_on(client, monkeypatch):
    monkeypatch.setattr(settings, "auth_enabled", True)
    monkeypatch.setattr(settings, "oidc_jwks_url", "https://keycloak.test/certs")

    def down(url: str, timeout: float) -> httpx.Response:
        raise httpx.ConnectTimeout("timed out")

    monkeypatch.setattr(main.httpx, "get", down)
    resp = client.get("/api/v1/readyz")
    assert resp.status_code == 503
    assert resp.json()["checks"] == {"kubernetes": "ok", "jwks": "failed"}

    def up(url: str, timeout: float) -> httpx.Response:
        return httpx.Response(200, json={"keys": [{"kid": "k"}]}, request=httpx.Request("GET", url))

    monkeypatch.setattr(main.httpx, "get", up)
    assert client.get("/api/v1/readyz").status_code == 200


def test_liveness_stays_static(client, store):
    store.ready = False
    assert client.get("/api/v1/healthz").status_code == 200
