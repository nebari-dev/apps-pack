"""Kubernetes access layer for App custom resources and their children.

All cluster access goes through the AppStore interface so tests can swap in
an in-memory fake.
"""

from __future__ import annotations

from collections.abc import Callable
from datetime import UTC
from typing import TYPE_CHECKING, Any, Protocol, cast

if TYPE_CHECKING:
    from kubernetes.client import V1Pod

GROUP = "apps.nebari.dev"
VERSION = "v1alpha1"
PLURAL = "apps"
MANAGED_LABEL = "nebari.dev/managed"
APP_LABEL = "apps.nebari.dev/app"
# The operator always names the app's own container "app" (and puts it
# first); restricted apps add an "authz" sidecar next to it.
APP_CONTAINER = "app"
# Seconds a readiness check may wait on a dependency.
READY_TIMEOUT = 3
# (connect, read) seconds for every other apiserver call, so a slow apiserver
# cannot pin the API's worker threads.
REQUEST_TIMEOUT = (5, 30)
# Page size for list calls; results are followed through `continue` tokens.
PAGE_SIZE = 500


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

    def check_ready(self) -> None: ...

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
                return _list_custom(self._custom.list_namespaced_custom_object, GROUP, VERSION, namespace, PLURAL)
            if self._namespaces is not None:
                items: list[dict[str, Any]] = []
                for ns in self._namespaces:
                    items += _list_custom(self._custom.list_namespaced_custom_object, GROUP, VERSION, ns, PLURAL)
                return items
            return _list_custom(self._custom.list_cluster_custom_object, GROUP, VERSION, PLURAL)
        except Exception as exc:
            raise self._wrap(exc) from exc

    def get_app(self, namespace: str, name: str) -> dict[str, Any]:
        try:
            return _obj(
                self._custom.get_namespaced_custom_object(
                    GROUP, VERSION, namespace, PLURAL, name, _request_timeout=REQUEST_TIMEOUT
                )
            )
        except Exception as exc:
            raise self._wrap(exc) from exc

    def create_app(self, namespace: str, body: dict[str, Any]) -> dict[str, Any]:
        try:
            return _obj(
                self._custom.create_namespaced_custom_object(
                    GROUP, VERSION, namespace, PLURAL, body, _request_timeout=REQUEST_TIMEOUT
                )
            )
        except Exception as exc:
            raise self._wrap(exc) from exc

    def replace_app(self, namespace: str, name: str, body: dict[str, Any]) -> dict[str, Any]:
        try:
            return _obj(
                self._custom.replace_namespaced_custom_object(
                    GROUP, VERSION, namespace, PLURAL, name, body, _request_timeout=REQUEST_TIMEOUT
                )
            )
        except Exception as exc:
            raise self._wrap(exc) from exc

    def delete_app(self, namespace: str, name: str) -> None:
        try:
            self._custom.delete_namespaced_custom_object(
                GROUP, VERSION, namespace, PLURAL, name, _request_timeout=REQUEST_TIMEOUT
            )
        except Exception as exc:
            raise self._wrap(exc) from exc

    def check_ready(self) -> None:
        """Raise unless the API server answers a namespace list within a few seconds."""
        self._core.list_namespace(limit=1, _request_timeout=READY_TIMEOUT)

    def list_managed_namespaces(self) -> list[str]:
        namespaces = _list_typed(self._core.list_namespace, label_selector=f"{MANAGED_LABEL}=true")
        return sorted(ns.metadata.name for ns in namespaces if ns.metadata and ns.metadata.name)

    def pod_logs(self, namespace: str, app_name: str, lines: int, container: str | None) -> str:
        pods = self._core.list_namespaced_pod(
            namespace, label_selector=f"{APP_LABEL}={app_name}", limit=1, _request_timeout=REQUEST_TIMEOUT
        )
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
                # Restricted apps run an authz sidecar too, and the apiserver
                # needs a container name for multi-container pods: default to
                # the app's own container.
                container=container or APP_CONTAINER,
                tail_lines=lines,
                _preload_content=False,
                _request_timeout=REQUEST_TIMEOUT,
            )
        except Exception as exc:
            raise self._wrap(exc) from exc
        data = resp.data
        return data.decode("utf-8", errors="replace") if isinstance(data, bytes) else str(data)

    def app_events(self, namespace: str, app_name: str) -> list[dict[str, Any]]:
        """Events for the App and its children, fetched by field selector.

        A field selector cannot match a name prefix, so the children are named
        explicitly: `app-<name>` (Deployment, Service, ConfigMap, NebariApp),
        and each current pod and the ReplicaSet that owns it.
        """
        selectors = [f"involvedObject.kind=App,involvedObject.name={app_name}"]
        names = {f"app-{app_name}"}
        pods = _list_typed(self._core.list_namespaced_pod, namespace, label_selector=f"{APP_LABEL}={app_name}")
        for pod in pods:
            if pod.metadata and pod.metadata.name:
                names.add(pod.metadata.name)
                names.update(ref.name for ref in pod.metadata.owner_references or [] if ref.kind == "ReplicaSet")
        selectors += [f"involvedObject.name={n}" for n in sorted(names)]
        related: list[dict[str, Any]] = []
        for selector in selectors:
            for ev in _list_typed(self._core.list_namespaced_event, namespace, field_selector=selector):
                involved = ev.involved_object
                related.append(
                    {
                        "type": ev.type or "",
                        "reason": ev.reason or "",
                        "message": ev.message or "",
                        "kind": involved.kind or "",
                        "object": involved.name or "",
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
            self._apps.patch_namespaced_deployment(
                f"app-{app_name}", namespace, patch, _request_timeout=REQUEST_TIMEOUT
            )
        except Exception as exc:
            raise self._wrap(exc) from exc

    def pod_metrics(self, namespace: str, app_name: str) -> list[dict[str, Any]]:
        try:
            res = self._custom.list_namespaced_custom_object(
                "metrics.k8s.io",
                "v1beta1",
                namespace,
                "pods",
                label_selector=f"{APP_LABEL}={app_name}",
                _request_timeout=REQUEST_TIMEOUT,
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
            items = _list_custom(
                self._custom.list_cluster_custom_object, "metrics.k8s.io", "v1beta1", "pods", label_selector=APP_LABEL
            )
        except Exception as exc:
            raise self._wrap(exc) from exc
        out: list[dict[str, Any]] = []
        for item in items:
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
                    items += _list_typed(self._core.list_namespaced_pod, ns, label_selector=APP_LABEL)
            else:
                items = _list_typed(self._core.list_pod_for_all_namespaces, label_selector=APP_LABEL)
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


def _list_custom(call: Callable[..., object], *args: Any, **kwargs: Any) -> list[dict[str, Any]]:
    """Every item of a custom-object list, a page at a time."""
    items: list[dict[str, Any]] = []
    token = ""
    while True:
        res = _obj(call(*args, limit=PAGE_SIZE, _continue=token or None, _request_timeout=REQUEST_TIMEOUT, **kwargs))
        items += _items(res)
        token = (res.get("metadata") or {}).get("continue") or ""
        if not token:
            return items


def _list_typed(call: Callable[..., Any], *args: Any, **kwargs: Any) -> list[Any]:
    """Every item of a typed (core/apps) list, a page at a time."""
    items: list[Any] = []
    token = ""
    while True:
        res = call(*args, limit=PAGE_SIZE, _continue=token or None, _request_timeout=REQUEST_TIMEOUT, **kwargs)
        items += res.items
        token = (res.metadata and res.metadata._continue) or ""
        if not token:
            return items


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
