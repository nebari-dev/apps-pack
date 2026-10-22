"""Authorization: owner, manager or admin on every App route."""

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
# Listed in alices' spec.access.managers by username (case differs on purpose)
# and through a group in the token (with Keycloak's leading "/").
DAVE = User(username="dave", groups=["developer"])
ERIN = User(username="erin", groups=["/web-team"])
MANAGERS = {"users": ["Dave"], "groups": ["web-team"]}


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
    body = make_app_body("alices")
    body["access"]["managers"] = MANAGERS
    resp = as_user(ALICE).post(f"{PREFIX}/apps", json=body)
    assert resp.status_code == 201, resp.text
    assert resp.json()["owner"] == "alice"
    assert resp.json()["access"]["managers"] == MANAGERS


# Every route addressing one App, with the request that exercises it.
APP_ROUTES = {
    ("GET", "/apps/{namespace}/{name}"): {},
    ("PATCH", "/apps/{namespace}/{name}"): {"json": {"displayName": "pwned"}},
    ("PATCH", "/apps/{namespace}/{name}/secrets"): {"json": {"API_KEY": "pwned"}},
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
def test_non_owner_non_manager_gets_403(as_user, alice_app, store, method, path):
    url = PREFIX + path.format(namespace="apps", name="alices")
    resp = as_user(BOB).request(method, url, **APP_ROUTES[(method, path)])
    assert resp.status_code == 403, resp.text
    # Nothing changed.
    assert store.apps[("apps", "alices")]["spec"]["displayName"] == "Docs Site"
    assert store.restarted == []
    assert store.secrets == {}


@pytest.mark.parametrize("method,path", sorted(APP_ROUTES))
@pytest.mark.parametrize("user", [ALICE, ADMIN, DAVE, ERIN], ids=["owner", "admin", "manager-user", "manager-group"])
def test_owner_manager_and_admin_allowed(as_user, alice_app, method, path, user):
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


def test_roles_reported(as_user, alice_app):
    role = lambda u: as_user(u).get(f"{PREFIX}/apps/apps/alices").json()["role"]  # noqa: E731
    assert [role(u) for u in (ALICE, DAVE, ERIN, ADMIN)] == ["owner", "manager", "manager", "admin"]
    assert [a["role"] for a in as_user(DAVE).get(f"{PREFIX}/apps").json()] == ["manager"]


def test_list_includes_managed_apps(as_user, alice_app):
    as_user(BOB).post(f"{PREFIX}/apps", json=make_app_body("bobs"))
    names = lambda c: sorted(a["name"] for a in c.get(f"{PREFIX}/apps").json())  # noqa: E731
    assert names(as_user(DAVE)) == ["alices"]
    assert names(as_user(ERIN)) == ["alices"]
    assert as_user(ERIN).get(f"{PREFIX}/analytics/summary").json()["total"] == 1


def test_group_membership_comes_from_the_token(as_user, alice_app):
    """A group named like a manager username, or a username named like a
    manager group, does not count.
    """
    assert as_user(User(username="web-team")).get(f"{PREFIX}/apps/apps/alices").status_code == 403
    assert as_user(User(username="x", groups=["Dave"])).get(f"{PREFIX}/apps/apps/alices").status_code == 403


def test_groups_match_as_full_paths(as_user, alice_app):
    """Groups match the way nebari-operator matches access.groups: "web-team"
    and "/web-team" are the same group, a subgroup or a same-named group under
    another parent is not, and neither is a parent of the listed group.
    """
    get = lambda u: as_user(u).get(f"{PREFIX}/apps/apps/alices").status_code  # noqa: E731
    assert get(User(username="x", groups=["/web-team/"])) == 200
    assert get(User(username="x", groups=["/web-team/frontend"])) == 403
    assert get(User(username="x", groups=["/eng/web-team"])) == 403
    assert get(User(username="x", groups=["/team/admin"])) == 403
    assert get(User(username="x", groups=["/admin"])) == 200


NEW_MANAGERS = {"users": ["mallory"], "groups": []}


def access_with(managers):
    access = {"public": True, "subdomain": "alices"}
    if managers is not ...:
        access["managers"] = managers
    return {"access": access}


@pytest.mark.parametrize("user", [DAVE, ERIN], ids=["manager-user", "manager-group"])
@pytest.mark.parametrize("managers", [NEW_MANAGERS, None, {}], ids=["replace", "null", "empty"])
def test_manager_cannot_change_managers(as_user, alice_app, store, user, managers):
    resp = as_user(user).patch(f"{PREFIX}/apps/apps/alices", json=access_with(managers))
    assert resp.status_code == 403, resp.text
    assert store.apps[("apps", "alices")]["spec"]["access"]["managers"] == MANAGERS


def test_manager_can_edit_access_keeping_managers(as_user, alice_app, store):
    """A manager may edit the rest of access: sending the list unchanged, or
    not at all, is not a change to it.
    """
    dave = as_user(DAVE)
    resp = dave.patch(
        f"{PREFIX}/apps/apps/alices", json={"access": {**access_with(MANAGERS)["access"], "public": False}}
    )
    assert resp.status_code == 200, resp.text
    resp = dave.patch(f"{PREFIX}/apps/apps/alices", json={"access": {**access_with(...)["access"], "groups": ["g"]}})
    assert resp.status_code == 200, resp.text
    access = store.apps[("apps", "alices")]["spec"]["access"]
    assert access["managers"] == MANAGERS
    assert access["groups"] == ["g"]


@pytest.mark.parametrize("user", [ALICE, ADMIN], ids=["owner", "admin"])
def test_owner_and_admin_can_change_managers(as_user, alice_app, store, user):
    resp = as_user(user).patch(f"{PREFIX}/apps/apps/alices", json=access_with(NEW_MANAGERS))
    assert resp.status_code == 200, resp.text
    assert resp.json()["access"]["managers"] == {"users": ["mallory"], "groups": []}
    # Dave is no longer a manager.
    assert as_user(DAVE).get(f"{PREFIX}/apps/apps/alices").status_code == 403
    assert as_user(User(username="mallory")).get(f"{PREFIX}/apps/apps/alices").status_code == 200
    # Cleared with null.
    resp = as_user(user).patch(f"{PREFIX}/apps/apps/alices", json=access_with(None))
    assert resp.status_code == 200, resp.text
    assert "managers" not in store.apps[("apps", "alices")]["spec"]["access"]


def test_blank_manager_entries_rejected(as_user, alice_app):
    resp = as_user(ALICE).patch(f"{PREFIX}/apps/apps/alices", json=access_with({"users": [" "]}))
    assert resp.status_code == 422
    resp = as_user(ALICE).patch(f"{PREFIX}/apps/apps/alices", json=access_with({"groups": ["/"]}))
    assert resp.status_code == 422
    assert "access.managers.groups" in resp.json()["detail"]


def test_manager_of_unowned_app(as_user, store):
    """An App created with kubectl has no owner but may still list managers."""
    as_user(ADMIN).post(f"{PREFIX}/apps", json=make_app_body("kubectl-app"))
    cr = store.apps[("apps", "kubectl-app")]
    cr["spec"].pop("owner")
    cr["metadata"]["labels"] = {}
    cr["spec"]["access"]["managers"] = {"groups": ["web-team"]}
    assert as_user(ERIN).get(f"{PREFIX}/apps/apps/kubectl-app").status_code == 200
    assert as_user(ALICE).get(f"{PREFIX}/apps/apps/kubectl-app").status_code == 403
