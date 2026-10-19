"""KubernetesAppStore never lists cluster-wide when scoped to namespaces
(the chart then grants the API only per-namespace RoleBindings)."""

from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import MagicMock

from nebari_apps_api.k8s import KubernetesAppStore


def scoped_store(namespaces):
    store = KubernetesAppStore.__new__(KubernetesAppStore)
    store._namespaces = namespaces
    store._custom = MagicMock()
    store._core = MagicMock()
    store._custom.list_namespaced_custom_object.side_effect = lambda g, v, ns, p: {
        "items": [{"metadata": {"name": f"a-{ns}", "namespace": ns}}]
    }
    pod = lambda ns: SimpleNamespace(  # noqa: E731
        metadata=SimpleNamespace(namespace=ns, labels={"apps.nebari.dev/app": "x"}),
        status=SimpleNamespace(container_statuses=[SimpleNamespace(restart_count=2)]),
    )
    store._core.list_namespaced_pod.side_effect = lambda ns, label_selector: SimpleNamespace(items=[pod(ns)])
    return store


def test_scoped_list_apps_iterates_namespaces():
    store = scoped_store(["apps", "team-a"])
    names = [a["metadata"]["name"] for a in store.list_apps(None)]
    assert names == ["a-apps", "a-team-a"]
    store._custom.list_cluster_custom_object.assert_not_called()


def test_scoped_restarts_iterate_namespaces():
    store = scoped_store(["apps", "team-a"])
    assert [p["namespace"] for p in store.app_restarts()] == ["apps", "team-a"]
    store._core.list_pod_for_all_namespaces.assert_not_called()


def test_unscoped_uses_cluster_wide_calls():
    store = scoped_store(None)
    store._custom.list_cluster_custom_object.return_value = {"items": []}
    store._core.list_pod_for_all_namespaces.return_value = SimpleNamespace(items=[])
    store.list_apps(None)
    store.app_restarts()
    store._custom.list_cluster_custom_object.assert_called_once()
    store._core.list_pod_for_all_namespaces.assert_called_once()
