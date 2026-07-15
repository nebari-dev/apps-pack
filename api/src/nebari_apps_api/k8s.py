"""Kubernetes access layer for App custom resources and their children.

All cluster access goes through the AppStore interface so tests can swap in
an in-memory fake.
"""

from __future__ import annotations

from typing import Any, Protocol

GROUP = "apps.nebari.dev"
VERSION = "v1alpha1"
PLURAL = "apps"
MANAGED_LABEL = "nebari.dev/managed"


class NotFoundError(Exception):
    pass


class ConflictError(Exception):
    pass


class AppStore(Protocol):
    """The subset of cluster operations the API needs."""

    def list_apps(self, namespace: str | None) -> list[dict[str, Any]]: ...

    def get_app(self, namespace: str, name: str) -> dict[str, Any]: ...

    def create_app(self, namespace: str, body: dict[str, Any]) -> dict[str, Any]: ...

    def replace_app(self, namespace: str, name: str, body: dict[str, Any]) -> dict[str, Any]: ...

    def delete_app(self, namespace: str, name: str) -> None: ...

    def list_managed_namespaces(self) -> list[str]: ...

    def pod_logs(self, namespace: str, app_name: str, lines: int, container: str | None) -> str: ...

    def app_events(self, namespace: str, app_name: str) -> list[dict[str, Any]]: ...


class KubernetesAppStore:
    """AppStore backed by the real cluster (in-cluster or kubeconfig)."""

    def __init__(self) -> None:
        from kubernetes import client, config

        try:
            config.load_incluster_config()
        except config.ConfigException:
            config.load_kube_config()

        self._custom = client.CustomObjectsApi()
        self._core = client.CoreV1Api()

    def _wrap(self, exc: Exception) -> Exception:
        from kubernetes.client.rest import ApiException

        if isinstance(exc, ApiException):
            if exc.status == 404:
                return NotFoundError(str(exc.reason))
            if exc.status == 409:
                return ConflictError(str(exc.reason))
        return exc

    def list_apps(self, namespace: str | None) -> list[dict[str, Any]]:
        try:
            if namespace:
                res = self._custom.list_namespaced_custom_object(GROUP, VERSION, namespace, PLURAL)
            else:
                res = self._custom.list_cluster_custom_object(GROUP, VERSION, PLURAL)
        except Exception as exc:  # noqa: BLE001
            raise self._wrap(exc) from exc
        return res.get("items", [])

    def get_app(self, namespace: str, name: str) -> dict[str, Any]:
        try:
            return self._custom.get_namespaced_custom_object(GROUP, VERSION, namespace, PLURAL, name)
        except Exception as exc:  # noqa: BLE001
            raise self._wrap(exc) from exc

    def create_app(self, namespace: str, body: dict[str, Any]) -> dict[str, Any]:
        try:
            return self._custom.create_namespaced_custom_object(GROUP, VERSION, namespace, PLURAL, body)
        except Exception as exc:  # noqa: BLE001
            raise self._wrap(exc) from exc

    def replace_app(self, namespace: str, name: str, body: dict[str, Any]) -> dict[str, Any]:
        try:
            return self._custom.replace_namespaced_custom_object(GROUP, VERSION, namespace, PLURAL, name, body)
        except Exception as exc:  # noqa: BLE001
            raise self._wrap(exc) from exc

    def delete_app(self, namespace: str, name: str) -> None:
        try:
            self._custom.delete_namespaced_custom_object(GROUP, VERSION, namespace, PLURAL, name)
        except Exception as exc:  # noqa: BLE001
            raise self._wrap(exc) from exc

    def list_managed_namespaces(self) -> list[str]:
        namespaces = self._core.list_namespace(label_selector=f"{MANAGED_LABEL}=true")
        return sorted(ns.metadata.name for ns in namespaces.items)

    def pod_logs(self, namespace: str, app_name: str, lines: int, container: str | None) -> str:
        pods = self._core.list_namespaced_pod(
            namespace, label_selector=f"apps.nebari.dev/app={app_name}"
        )
        if not pods.items:
            raise NotFoundError(f"no pods found for app {app_name}")
        pod = pods.items[0]
        try:
            # Skip the client's deserializer: it str()s the raw bytes, which
            # mangles the log text into a Python bytes repr.
            resp = self._core.read_namespaced_pod_log(
                pod.metadata.name,
                namespace,
                container=container,
                tail_lines=lines,
                _preload_content=False,
            )
        except Exception as exc:  # noqa: BLE001
            raise self._wrap(exc) from exc
        data = resp.data
        return data.decode("utf-8", errors="replace") if isinstance(data, bytes) else str(data)

    def app_events(self, namespace: str, app_name: str) -> list[dict[str, Any]]:
        events = self._core.list_namespaced_event(namespace)
        related = []
        prefix = f"app-{app_name}"
        for ev in events.items:
            involved = ev.involved_object
            name = involved.name or ""
            if involved.kind == "App" and name == app_name or name.startswith(prefix):
                related.append(
                    {
                        "type": ev.type or "",
                        "reason": ev.reason or "",
                        "message": ev.message or "",
                        "kind": involved.kind or "",
                        "object": name,
                        "count": ev.count or 1,
                        "lastTimestamp": str(ev.last_timestamp or ev.event_time or ""),
                    }
                )
        related.sort(key=lambda e: e["lastTimestamp"], reverse=True)
        return related
