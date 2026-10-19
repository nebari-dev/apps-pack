"""Authorization: owner-or-admin on every App route."""

from __future__ import annotations

import pytest
from fastapi.routing import APIRoute
from fastapi.testclient import TestClient

from nebari_apps_api.auth import User, current_user
from nebari_apps_api.config import settings
from nebari_apps_api.main import PREFIX, create_app

from .test_apps import make_app_body

ALICE = User(username="alice", groups=["developer"])
BOB = User(username="bob", groups=["developer"])
ADMIN = User(username="root", groups=["admin"])


@pytest.fixture(autouse=True)
def auth_on(monkeypatch):
    monkeypatch.setattr(settings, "auth_enabled", True)
    monkeypatch.setattr(settings, "admin_groups", ["admin"])


@pytest.fixture
def as_user(store):
    """Return a TestClient factory acting as the given user."""
    app = create_app(store)

    def make(user: User) -> TestClient:
        app.dependency_overrides[current_user] = lambda: user
        return TestClient(app)

    return make


@pytest.fixture
def alice_app(as_user):
    resp = as_user(ALICE).post(f"{PREFIX}/apps", json=make_app_body("alices"))
    assert resp.status_code == 201, resp.text
    assert resp.json()["owner"] == "alice"


# Every route addressing one App, with the request that exercises it.
APP_ROUTES = {
    ("GET", "/apps/{namespace}/{name}"): {},
    ("PATCH", "/apps/{namespace}/{name}"): {"json": {"displayName": "pwned"}},
    ("DELETE", "/apps/{namespace}/{name}"): {},
    ("POST", "/apps/{namespace}/{name}/stop"): {},
    ("POST", "/apps/{namespace}/{name}/start"): {},
    ("POST", "/apps/{namespace}/{name}/restart"): {},
    ("GET", "/apps/{namespace}/{name}/status"): {},
    ("GET", "/apps/{namespace}/{name}/logs"): {},
    ("GET", "/apps/{namespace}/{name}/events"): {},
    ("GET", "/apps/{namespace}/{name}/metrics"): {},
}


def test_every_app_route_is_covered(store):
    """Fail when a new per-App route is added without an authorization case."""
    app = create_app(store)
    routes = {
        (method, route.path.removeprefix(PREFIX))
        for route in app.routes
        if isinstance(route, APIRoute) and "{name}" in route.path
        for method in route.methods
    }
    assert routes == set(APP_ROUTES)


@pytest.mark.parametrize("method,path", sorted(APP_ROUTES))
def test_non_owner_gets_403(as_user, alice_app, store, method, path):
    url = PREFIX + path.format(namespace="apps", name="alices")
    resp = as_user(BOB).request(method, url, **APP_ROUTES[(method, path)])
    assert resp.status_code == 403, resp.text
    # Nothing changed.
    assert store.apps[("apps", "alices")]["spec"]["displayName"] == "Docs Site"
    assert store.restarted == []


@pytest.mark.parametrize("method,path", sorted(APP_ROUTES))
@pytest.mark.parametrize("user", [ALICE, ADMIN], ids=["owner", "admin"])
def test_owner_and_admin_allowed(as_user, alice_app, method, path, user):
    url = PREFIX + path.format(namespace="apps", name="alices")
    resp = as_user(user).request(method, url, **APP_ROUTES[(method, path)])
    assert resp.status_code < 400, resp.text


def test_admin_groups_configurable(as_user, alice_app, monkeypatch):
    ops = User(username="carol", groups=["/platform-ops"])
    assert as_user(ops).get(f"{PREFIX}/apps/apps/alices").status_code == 403
    monkeypatch.setattr(settings, "admin_groups", ["platform-ops"])
    assert as_user(ops).get(f"{PREFIX}/apps/apps/alices").status_code == 200


def test_unowned_app_is_admin_only(as_user, store):
    """Apps created with kubectl carry no owner: only admins may touch them."""
    as_user(ADMIN).post(f"{PREFIX}/apps", json=make_app_body("kubectl-app"))
    cr = store.apps[("apps", "kubectl-app")]
    cr["spec"].pop("owner")
    cr["metadata"]["labels"] = {}
    assert as_user(ALICE).get(f"{PREFIX}/apps/apps/kubectl-app").status_code == 403
    assert as_user(ADMIN).get(f"{PREFIX}/apps/apps/kubectl-app").status_code == 200


def test_list_and_analytics_filtered(as_user, alice_app):
    as_user(BOB).post(f"{PREFIX}/apps", json=make_app_body("bobs"))

    names = lambda c: sorted(a["name"] for a in c.get(f"{PREFIX}/apps").json())  # noqa: E731
    assert names(as_user(ALICE)) == ["alices"]
    assert names(as_user(BOB)) == ["bobs"]
    assert names(as_user(ADMIN)) == ["alices", "bobs"]

    assert as_user(BOB).get(f"{PREFIX}/analytics/summary").json()["total"] == 1
    assert as_user(ADMIN).get(f"{PREFIX}/analytics/summary").json()["total"] == 2

    metrics = as_user(BOB).get(f"{PREFIX}/analytics/metrics").json()
    assert [a["name"] for a in metrics["apps"]] == ["bobs"]


def test_path_namespace_checked(as_user, store):
    """A namespace outside the launchable set is refused on every route, not
    only on create, even for an admin and even if an App exists there.
    """
    store.apps[("kube-system", "x")] = {"metadata": {"name": "x", "namespace": "kube-system"}, "spec": {}}
    admin = as_user(ADMIN)
    assert admin.get(f"{PREFIX}/apps/kube-system/x").status_code == 403
    assert admin.delete(f"{PREFIX}/apps/kube-system/x").status_code == 403
    assert admin.get(f"{PREFIX}/apps", params={"namespace": "kube-system"}).status_code == 403
    assert [a["name"] for a in admin.get(f"{PREFIX}/apps").json()] == []
    assert ("kube-system", "x") in store.apps


def test_create_cannot_overwrite_other_users_app(as_user, alice_app):
    resp = as_user(BOB).post(f"{PREFIX}/apps", json=make_app_body("alices"))
    assert resp.status_code == 409


def test_me_reports_admin(as_user):
    assert as_user(ALICE).get(f"{PREFIX}/auth/me").json()["admin"] is False
    assert as_user(ADMIN).get(f"{PREFIX}/auth/me").json()["admin"] is True
