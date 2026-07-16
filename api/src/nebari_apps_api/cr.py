"""Convert between API models and App custom resource dicts."""

from __future__ import annotations

from typing import Any

from .k8s import GROUP, VERSION
from .models import AppCreate, AppOut, AppPatch

API_VERSION = f"{GROUP}/{VERSION}"


def _clean(obj: Any) -> Any:
    """Drop None values and empty containers so CRs stay tidy."""
    if isinstance(obj, dict):
        out = {k: _clean(v) for k, v in obj.items()}
        return {k: v for k, v in out.items() if v not in (None, {}, [], "")}
    if isinstance(obj, list):
        return [_clean(v) for v in obj]
    return obj


def to_cr(req: AppCreate, owner: str) -> dict[str, Any]:
    spec: dict[str, Any] = {
        "displayName": req.displayName,
        "description": req.description,
        "thumbnail": req.thumbnail,
        "owner": owner,
        "source": _clean(req.source.model_dump()),
        "runtime": _clean(req.runtime.model_dump()),
        "access": {
            "public": req.access.public,
            "groups": req.access.groups,
            "users": req.access.users,
            "subdomain": req.access.subdomain,
        },
    }
    return {
        "apiVersion": API_VERSION,
        "kind": "App",
        "metadata": {
            "name": req.name,
            "namespace": req.namespace,
            "labels": {"apps.nebari.dev/owner": owner} if owner else {},
        },
        "spec": _clean(spec) | {"access": {**_clean(spec["access"]), "public": req.access.public}},
    }


def apply_patch(cr: dict[str, Any], patch: AppPatch) -> dict[str, Any]:
    spec = cr.setdefault("spec", {})
    if patch.displayName is not None:
        spec["displayName"] = patch.displayName
    if patch.description is not None:
        spec["description"] = patch.description
    if patch.thumbnail is not None:
        spec["thumbnail"] = patch.thumbnail
    if patch.source is not None:
        spec["source"] = _clean(patch.source.model_dump())
    if patch.runtime is not None:
        spec["runtime"] = _clean(patch.runtime.model_dump())
    if patch.access is not None:
        spec["access"] = _clean(patch.access.model_dump()) | {"public": patch.access.public}
    return cr


def from_cr(cr: dict[str, Any]) -> AppOut:
    meta = cr.get("metadata", {})
    spec = cr.get("spec", {})
    status = cr.get("status", {})
    return AppOut(
        name=meta.get("name", ""),
        namespace=meta.get("namespace", ""),
        displayName=spec.get("displayName", ""),
        description=spec.get("description", ""),
        thumbnail=spec.get("thumbnail", ""),
        owner=spec.get("owner", ""),
        createdAt=meta.get("creationTimestamp", ""),
        source=spec.get("source"),
        runtime=spec.get("runtime"),
        access=spec.get("access"),
        status={
            "phase": status.get("phase", "Pending"),
            "url": status.get("url", ""),
            "replicas": status.get("replicas"),
            "conditions": status.get("conditions", []),
            "message": status.get("message", ""),
        },
    )
