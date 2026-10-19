"""Prometheus metrics: route templates as labels, statuses counted, /metrics unauthenticated."""

from __future__ import annotations

from prometheus_client import REGISTRY

from nebari_apps_api.config import settings

from .test_apps import make_app_body


def sample(name: str, **labels: str) -> float:
    return REGISTRY.get_sample_value(name, labels) or 0.0


def test_requests_are_counted_by_route_template(client):
    route = "/api/v1/apps/{namespace}/{name}"
    before_ok = sample("apps_api_requests_total", method="GET", route=route, status="200")
    before_404 = sample("apps_api_requests_total", method="GET", route=route, status="404")
    assert client.post("/api/v1/apps", json=make_app_body()).status_code == 201
    assert client.get("/api/v1/apps/apps/docs-site").status_code == 200
    assert client.get("/api/v1/apps/apps/nope").status_code == 404

    assert sample("apps_api_requests_total", method="GET", route=route, status="200") == before_ok + 1
    assert sample("apps_api_requests_total", method="GET", route=route, status="404") == before_404 + 1
    assert sample("apps_api_request_duration_seconds_count", method="GET", route=route) >= 2


def test_unknown_paths_share_one_label(client):
    before = sample("apps_api_requests_total", method="GET", route="unmatched", status="404")
    client.get("/api/v1/does-not-exist-1")
    client.get("/api/v1/does-not-exist-2")
    assert sample("apps_api_requests_total", method="GET", route="unmatched", status="404") == before + 2


def test_metrics_endpoint_needs_no_token_and_is_not_counted(client, monkeypatch):
    monkeypatch.setattr(settings, "auth_enabled", True)
    resp = client.get("/metrics")
    assert resp.status_code == 200
    assert resp.headers["content-type"].startswith("text/plain")
    assert "apps_api_requests_total" in resp.text
    # Scrapes do not count themselves.
    assert 'route="/metrics"' not in resp.text
    # The API itself still requires a token.
    assert client.get("/api/v1/apps").status_code == 401
