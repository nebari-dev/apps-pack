"""KubernetesAppStore.write_secret: create the App's Secret, or merge into it, without reading it."""

from __future__ import annotations

import base64
from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest
from kubernetes.client import ApiException

from nebari_apps_api.k8s import KubernetesAppStore, NotFoundError

OWNER = {"apiVersion": "apps.nebari.dev/v1alpha1", "kind": "App", "name": "docs", "uid": "u-1"}
LABELS = {"apps.nebari.dev/app": "docs"}


def make_store():
    store = KubernetesAppStore.__new__(KubernetesAppStore)
    store._namespaces = None
    store._core = MagicMock()
    return store


def b64(value: str) -> str:
    return base64.b64encode(value.encode()).decode()


def test_creates_the_secret_owned_by_the_app():
    store = make_store()
    store._core.create_namespaced_secret.return_value = SimpleNamespace(metadata=SimpleNamespace(resource_version="7"))
    version = store.write_secret("apps", "app-docs-secrets", OWNER, LABELS, {"API_KEY": "sk", "GONE": None})
    assert version == "7"
    namespace, secret = store._core.create_namespaced_secret.call_args.args
    assert namespace == "apps"
    assert secret.metadata.name == "app-docs-secrets"
    assert secret.metadata.owner_references[0].uid == "u-1"
    assert secret.metadata.labels == LABELS
    assert secret.data == {"API_KEY": b64("sk")}
    store._core.read_namespaced_secret.assert_not_called()
    store._core.patch_namespaced_secret.assert_not_called()


def test_merges_into_an_existing_secret():
    store = make_store()
    store._core.create_namespaced_secret.side_effect = ApiException(status=409, reason="AlreadyExists")
    store._core.patch_namespaced_secret.return_value = SimpleNamespace(metadata=SimpleNamespace(resource_version="9"))
    version = store.write_secret("apps", "app-docs-secrets", OWNER, LABELS, {"API_KEY": "new", "GONE": None})
    assert version == "9"
    name, namespace, body = store._core.patch_namespaced_secret.call_args.args
    assert (name, namespace) == ("app-docs-secrets", "apps")
    assert body["data"] == {"API_KEY": b64("new"), "GONE": None}
    assert body["metadata"]["ownerReferences"] == [OWNER]
    kwargs = store._core.patch_namespaced_secret.call_args.kwargs
    assert kwargs["_content_type"] == "application/strategic-merge-patch+json"
    store._core.read_namespaced_secret.assert_not_called()


def test_other_errors_propagate():
    store = make_store()
    store._core.create_namespaced_secret.side_effect = ApiException(status=404, reason="NotFound")
    with pytest.raises(NotFoundError):
        store.write_secret("gone", "app-docs-secrets", OWNER, LABELS, {"API_KEY": "v"})
    store._core.patch_namespaced_secret.assert_not_called()
