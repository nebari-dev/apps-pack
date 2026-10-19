"""Kubernetes access layer for App custom resources and their children.

All cluster access goes through the AppStore interface so tests can swap in
an in-memory fake.
"""

from __future__ import annotations

from datetime import UTC
from typing import TYPE_CHECKING, Any, Protocol, cast

if TYPE_CHECKING:
    from kubernetes.client import V1Pod

GROUP = "apps.nebari.dev"
VERSION = "v1alpha1"
PLURAL = "apps"
MANAGED_LABEL = "nebari.dev/managed"
APP_LABEL = "apps.nebari.dev/app"


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

    def restart_app(self, namespace: str, app_name: str) -> None: ...

    def pod_metrics(self, namespace: str, app_name: str) -> list[dict[str, Any]]: ...

    def cluster_pod_metrics(self) -> list[dict[str, Any]]: ...

    def app_restarts(self) -> list[dict[str, Any]]: ...


class KubernetesAppStore:
    """AppStore backed by the real cluster (in-cluster or kubeconfig)."""

    def __init__(self, namespaces: list[str] | None = None) -> None:
        """`namespaces` scopes every multi-namespace read to those namespaces
        (the chart grants the API RoleBindings only there). None means the API
        has cluster-wide access (app namespaces discovered by label).
        """
        from kubernetes import client, config

        self._namespaces = list(namespaces) if namespaces else None

        # The config loaders are the client's only unannotated entry points.
        try:
            config.load_incluster_config()  # type: ignore[no-untyped-call]
        except config.ConfigException:
            config.load_kube_config()  # type: ignore[no-untyped-call]

        self._custom = client.CustomObjectsApi()
        self._core = client.CoreV1Api()
        self._apps = client.AppsV1Api()

    def _wrap(self, exc: Exception) -> Exception:
        from kubernetes.client import ApiException

        if isinstance(exc, ApiException):
            if exc.status == 404:
                return NotFoundError(str(exc.reason))
            if exc.status == 409:
                return ConflictError(str(exc.reason))
        return exc

    def list_apps(self, namespace: str | None) -> list[dict[str, Any]]:
        try:
            if namespace:
                return _items(self._custom.list_namespaced_custom_object(GROUP, VERSION, namespace, PLURAL))
            if self._namespaces is not None:
                items: list[dict[str, Any]] = []
                for ns in self._namespaces:
                    items += _items(self._custom.list_namespaced_custom_object(GROUP, VERSION, ns, PLURAL))
                return items
            return _items(self._custom.list_cluster_custom_object(GROUP, VERSION, PLURAL))
        except Exception as exc:
            raise self._wrap(exc) from exc

    def get_app(self, namespace: str, name: str) -> dict[str, Any]:
        try:
            return _obj(self._custom.get_namespaced_custom_object(GROUP, VERSION, namespace, PLURAL, name))
        except Exception as exc:
            raise self._wrap(exc) from exc

    def create_app(self, namespace: str, body: dict[str, Any]) -> dict[str, Any]:
        try:
            return _obj(self._custom.create_namespaced_custom_object(GROUP, VERSION, namespace, PLURAL, body))
        except Exception as exc:
            raise self._wrap(exc) from exc

    def replace_app(self, namespace: str, name: str, body: dict[str, Any]) -> dict[str, Any]:
        try:
            return _obj(self._custom.replace_namespaced_custom_object(GROUP, VERSION, namespace, PLURAL, name, body))
        except Exception as exc:
            raise self._wrap(exc) from exc

    def delete_app(self, namespace: str, name: str) -> None:
        try:
            self._custom.delete_namespaced_custom_object(GROUP, VERSION, namespace, PLURAL, name)
        except Exception as exc:
            raise self._wrap(exc) from exc

    def list_managed_namespaces(self) -> list[str]:
        namespaces = self._core.list_namespace(label_selector=f"{MANAGED_LABEL}=true")
        return sorted(ns.metadata.name for ns in namespaces.items if ns.metadata and ns.metadata.name)

    def pod_logs(self, namespace: str, app_name: str, lines: int, container: str | None) -> str:
        pods = self._core.list_namespaced_pod(namespace, label_selector=f"apps.nebari.dev/app={app_name}")
        if not pods.items:
            raise NotFoundError(f"no pods found for app {app_name}")
        pod_name = pods.items[0].metadata.name if pods.items[0].metadata else None
        if not pod_name:
            raise NotFoundError(f"no pods found for app {app_name}")
        try:
            # Skip the client's deserializer: it str()s the raw bytes, which
            # mangles the log text into a Python bytes repr.
            # With _preload_content=False the call returns the raw urllib3
            # response, not the str its annotation promises.
            resp: Any = self._core.read_namespaced_pod_log(
                pod_name,
                namespace,
                container=container,
                tail_lines=lines,
                _preload_content=False,
            )
        except Exception as exc:
            raise self._wrap(exc) from exc
        data = resp.data
        return data.decode("utf-8", errors="replace") if isinstance(data, bytes) else str(data)

    def app_events(self, namespace: str, app_name: str) -> list[dict[str, Any]]:
        events = self._core.list_namespaced_event(namespace)
        related: list[dict[str, Any]] = []
        prefix = f"app-{app_name}"
        for ev in events.items:
            involved = ev.involved_object
            name = involved.name or ""
            if (involved.kind == "App" and name == app_name) or name.startswith(prefix):
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

    def restart_app(self, namespace: str, app_name: str) -> None:
        """Roll the app's pods, like `kubectl rollout restart`."""
        from datetime import datetime

        stamp = datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")
        patch = {"spec": {"template": {"metadata": {"annotations": {"kubectl.kubernetes.io/restartedAt": stamp}}}}}
        try:
            self._apps.patch_namespaced_deployment(f"app-{app_name}", namespace, patch)
        except Exception as exc:
            raise self._wrap(exc) from exc

    def pod_metrics(self, namespace: str, app_name: str) -> list[dict[str, Any]]:
        try:
            res = self._custom.list_namespaced_custom_object(
                "metrics.k8s.io",
                "v1beta1",
                namespace,
                "pods",
                label_selector=f"apps.nebari.dev/app={app_name}",
            )
        except Exception as exc:
            raise self._wrap(exc) from exc
        out: list[dict[str, Any]] = []
        for item in _items(res):
            cpu_milli = 0
            mem_mi = 0.0
            for container in item.get("containers", []):
                usage = container.get("usage", {})
                cpu_milli += _cpu_to_milli(usage.get("cpu", "0"))
                mem_mi += _mem_to_mi(usage.get("memory", "0"))
            out.append(
                {
                    "name": item.get("metadata", {}).get("name", ""),
                    "cpu": f"{cpu_milli}m",
                    "memory": f"{round(mem_mi)}Mi",
                }
            )
        return out

    def cluster_pod_metrics(self) -> list[dict[str, Any]]:
        """Per-pod usage for every app pod in the cluster, keyed by app + namespace.

        Raises NotFoundError when the metrics API is not installed so callers can
        report usage as unavailable rather than failing.
        """
        try:
            res = self._custom.list_cluster_custom_object("metrics.k8s.io", "v1beta1", "pods", label_selector=APP_LABEL)
        except Exception as exc:
            raise self._wrap(exc) from exc
        out: list[dict[str, Any]] = []
        for item in _items(res):
            meta = item.get("metadata", {})
            app = meta.get("labels", {}).get(APP_LABEL)
            if not app:
                continue
            cpu = sum(_cpu_to_milli(c.get("usage", {}).get("cpu", "0")) for c in item.get("containers", []))
            mem = sum(_mem_to_mi(c.get("usage", {}).get("memory", "0")) for c in item.get("containers", []))
            out.append({"namespace": meta.get("namespace", ""), "app": app, "cpu": cpu, "memory": mem})
        return out

    def app_restarts(self) -> list[dict[str, Any]]:
        """Total container restarts per app pod across the cluster (from pod status)."""
        try:
            if self._namespaces is not None:
                items: list[V1Pod] = []
                for ns in self._namespaces:
                    items += self._core.list_namespaced_pod(ns, label_selector=APP_LABEL).items
            else:
                items = self._core.list_pod_for_all_namespaces(label_selector=APP_LABEL).items
        except Exception as exc:
            raise self._wrap(exc) from exc
        out: list[dict[str, Any]] = []
        for pod in items:
            meta = pod.metadata
            app = (meta.labels or {}).get(APP_LABEL) if meta else None
            if not meta or not app:
                continue
            statuses = (pod.status.container_statuses if pod.status else None) or []
            restarts = sum(cs.restart_count or 0 for cs in statuses)
            out.append({"namespace": meta.namespace or "", "app": app, "restarts": restarts})
        return out


def _obj(res: object) -> dict[str, Any]:
    """Custom-object calls return the decoded JSON body, typed as object."""
    return cast("dict[str, Any]", res)


def _items(res: object) -> list[dict[str, Any]]:
    return cast("list[dict[str, Any]]", _obj(res).get("items", []))


def _cpu_to_milli(value: str) -> int:
    """Parse a Kubernetes CPU quantity to integer millicores."""
    value = value.strip()
    if not value:
        return 0
    if value.endswith("n"):
        return round(int(value[:-1]) / 1_000_000)
    if value.endswith("u"):
        return round(int(value[:-1]) / 1_000)
    if value.endswith("m"):
        return int(value[:-1])
    return round(float(value) * 1000)


def _mem_to_mi(value: str) -> float:
    """Parse a Kubernetes memory quantity to mebibytes (Mi)."""
    value = value.strip()
    if not value:
        return 0.0
    factors = {
        "Ki": 1 / 1024,
        "Mi": 1.0,
        "Gi": 1024.0,
        "Ti": 1024.0 * 1024,
        "K": 1000 / (1024 * 1024),
        "M": 1_000_000 / (1024 * 1024),
        "G": 1_000_000_000 / (1024 * 1024),
    }
    for suffix, factor in factors.items():
        if value.endswith(suffix):
            return float(value[: -len(suffix)]) * factor
    # plain bytes
    return float(value) / (1024 * 1024)
