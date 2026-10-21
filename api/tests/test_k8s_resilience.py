"""Timeouts and paging on every apiserver call; conflict retry on read-modify-write."""

from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest

from nebari_apps_api.k8s import PAGE_SIZE, REQUEST_TIMEOUT, KubernetesAppStore

APP = {
    "name": "docs-site",
    "namespace": "apps",
    "displayName": "Docs Site",
    "source": {"type": "inline", "inline": {"files": {"index.html": "<h1>hi</h1>"}}},
    "access": {"public": True, "subdomain": "docs-site"},
}


def page(items, token=None):
    return SimpleNamespace(items=items, metadata=SimpleNamespace(_continue=token))


def pod(name, rs):
    return SimpleNamespace(
        metadata=SimpleNamespace(
            name=name,
            namespace="apps",
            labels={"apps.nebari.dev/app": "demo"},
            owner_references=[SimpleNamespace(kind="ReplicaSet", name=rs)],
        ),
        spec=SimpleNamespace(containers=[]),
        status=SimpleNamespace(
            phase="Running",
            container_statuses=[SimpleNamespace(name="app", restart_count=0, state=None, last_state=None)],
        ),
    )


def event(kind, name, reason):
    return SimpleNamespace(
        involved_object=SimpleNamespace(kind=kind, name=name),
        type="Normal",
        reason=reason,
        message="",
        count=1,
        last_timestamp=reason,
        event_time=None,
    )


@pytest.fixture
def kube():
    store = KubernetesAppStore.__new__(KubernetesAppStore)
    store._namespaces = None
    store._custom = MagicMock()
    store._core = MagicMock()
    store._apps = MagicMock()
    store._custom.list_namespaced_custom_object.return_value = {"items": [], "metadata": {}}
    store._custom.list_cluster_custom_object.return_value = {"items": [], "metadata": {}}
    store._custom.get_namespaced_custom_object.return_value = {}
    store._custom.create_namespaced_custom_object.return_value = {}
    store._custom.replace_namespaced_custom_object.return_value = {}
    store._core.list_namespace.return_value = page([])
    store._core.list_namespaced_pod.return_value = page([pod("app-demo-abc-1", "app-demo-abc")])
    store._core.list_pod_for_all_namespaces.return_value = page([])
    store._core.list_namespaced_event.return_value = page([])
    store._core.read_namespaced_pod_log.return_value = SimpleNamespace(data=b"log")
    return store


def test_every_call_has_a_timeout(kube):
    kube.list_apps(None)
    kube.list_apps("apps")
    kube.get_app("apps", "demo")
    kube.create_app("apps", {})
    kube.replace_app("apps", "demo", {})
    kube.delete_app("apps", "demo")
    kube.list_managed_namespaces()
    kube.pod_logs("apps", "demo", 10, None)
    kube.app_events("apps", "demo")
    kube.restart_app("apps", "demo")
    kube.pod_metrics("apps", "demo")
    kube.pod_health("apps", "demo")
    kube.cluster_pod_metrics()
    kube.app_restarts()
    calls = kube._custom.mock_calls + kube._core.mock_calls + kube._apps.mock_calls
    assert len(calls) >= 13
    for call in calls:
        assert call.kwargs.get("_request_timeout") == REQUEST_TIMEOUT, call


def test_pod_logs_default_to_the_app_container(kube):
    # Restricted apps have an authz sidecar; the apiserver refuses a log
    # request for a multi-container pod without a container name.
    kube.pod_logs("apps", "demo", 10, None)
    assert kube._core.read_namespaced_pod_log.call_args.kwargs["container"] == "app"
    kube.pod_logs("apps", "demo", 10, "authz")
    assert kube._core.read_namespaced_pod_log.call_args.kwargs["container"] == "authz"


def test_lists_page_through_continue_tokens(kube):
    kube._custom.list_cluster_custom_object.side_effect = [
        {"items": [{"metadata": {"name": "a"}}], "metadata": {"continue": "t1"}},
        {"items": [{"metadata": {"name": "b"}}], "metadata": {}},
    ]
    assert [a["metadata"]["name"] for a in kube.list_apps(None)] == ["a", "b"]
    first, second = kube._custom.list_cluster_custom_object.call_args_list
    assert first.kwargs["limit"] == PAGE_SIZE and first.kwargs["_continue"] is None
    assert second.kwargs["_continue"] == "t1"


def test_events_are_field_selected(kube):
    by_selector = {
        "involvedObject.kind=App,involvedObject.name=demo": [event("App", "demo", "1-validated")],
        "involvedObject.name=app-demo": [event("Deployment", "app-demo", "2-scaled")],
        "involvedObject.name=app-demo-abc": [event("ReplicaSet", "app-demo-abc", "3-created")],
        "involvedObject.name=app-demo-abc-1": [event("Pod", "app-demo-abc-1", "4-pulled")],
    }
    kube._core.list_namespaced_event.side_effect = lambda ns, field_selector, **kw: page(by_selector[field_selector])
    events = kube.app_events("apps", "demo")
    assert [e["reason"] for e in events] == ["4-pulled", "3-created", "2-scaled", "1-validated"]
    for call in kube._core.list_namespaced_event.call_args_list:
        assert call.kwargs["field_selector"] in by_selector


@pytest.mark.parametrize(
    ("method", "path", "body"),
    [
        ("PATCH", "/api/v1/apps/apps/docs-site", {"displayName": "Renamed"}),
        ("POST", "/api/v1/apps/apps/docs-site/stop", None),
        ("POST", "/api/v1/apps/apps/docs-site/start", None),
    ],
)
def test_one_conflict_is_retried(client, store, method, path, body):
    assert client.post("/api/v1/apps", json=APP).status_code == 201
    store.conflicts = 1
    resp = client.request(method, path, json=body)
    assert resp.status_code == 200, resp.text
    assert store.conflicts == 0


@pytest.mark.parametrize(
    ("method", "path", "body"),
    [
        ("PATCH", "/api/v1/apps/apps/docs-site", {"displayName": "Renamed"}),
        ("POST", "/api/v1/apps/apps/docs-site/stop", None),
    ],
)
def test_second_conflict_is_409(client, store, method, path, body):
    assert client.post("/api/v1/apps", json=APP).status_code == 201
    store.conflicts = 2
    resp = client.request(method, path, json=body)
    assert resp.status_code == 409
    assert "changed by someone else" in resp.json()["detail"]
