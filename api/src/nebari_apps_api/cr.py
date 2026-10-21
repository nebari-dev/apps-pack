"""Convert between API models and App custom resource dicts."""

from __future__ import annotations

import re
from datetime import UTC, datetime
from typing import Any

from pydantic import BaseModel

from .k8s import GROUP, VERSION
from .models import AppCreate, AppOut, AppPatch, AppStatus

API_VERSION = f"{GROUP}/{VERSION}"

# Set on an App to wake it from Idle (operator/api/v1alpha1 WakeAnnotation):
# an RFC 3339 time the operator counts as a request.
WAKE_ANNOTATION = "apps.nebari.dev/wake-requested-at"


def wake_timestamp() -> str:
    return datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")


# A Kubernetes label value. Usernames that are not one (an email-style
# preferred_username) get no owner label: spec.owner is the owner either way,
# and rewriting the name to fit could collide with another user's.
_LABEL_VALUE = re.compile(r"^(([A-Za-z0-9][-A-Za-z0-9_.]*)?[A-Za-z0-9])?$")


def owner_labels(owner: str) -> dict[str, str]:
    if owner and len(owner) <= 63 and _LABEL_VALUE.match(owner):
        return {"apps.nebari.dev/owner": owner}
    return {}


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
    if req.landingPage is not None and req.landingPage.enabled is not None:
        # Written explicitly (not _clean'ed) so enabled=false survives.
        spec["landingPage"] = {"enabled": req.landingPage.enabled}
    return {
        "apiVersion": API_VERSION,
        "kind": "App",
        "metadata": {
            "name": req.name,
            "namespace": req.namespace,
            "labels": owner_labels(owner) | {"apps.nebari.dev/subdomain": req.access.subdomain},
        },
        "spec": _clean(spec) | {"access": {**_clean(spec["access"]), "public": req.access.public}},
    }


def _merge(current: Any, change: BaseModel) -> dict[str, Any]:
    """Merge the fields a PATCH sent into the stored object. Fields it did not
    send keep their stored value, so a partial runtime or access edit does not
    drop what another producer (kubectl, GitOps) set; a field sent empty or
    null is removed.
    """
    merged = dict(current) if isinstance(current, dict) else {}
    sent = change.model_dump(include=change.model_fields_set)
    for key, value in sent.items():
        value = _clean(value)
        if value in (None, {}, [], ""):
            merged.pop(key, None)
        else:
            merged[key] = value
    return merged


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
        spec["runtime"] = _merge(spec.get("runtime"), patch.runtime)
    if patch.access is not None:
        spec["access"] = _merge(spec.get("access"), patch.access) | {"public": patch.access.public}
    if patch.landingPage is not None:
        if patch.landingPage.enabled is None:
            spec.pop("landingPage", None)  # back to the cluster default
        else:
            spec["landingPage"] = {"enabled": patch.landingPage.enabled}
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
        landingPage=spec.get("landingPage"),
        status=AppStatus.model_validate(
            {
                "phase": status.get("phase", "Pending"),
                "url": status.get("url", ""),
                "replicas": status.get("replicas"),
                "conditions": status.get("conditions", []),
                "message": status.get("message", ""),
                "lastActivityTime": status.get("lastActivityTime", ""),
            }
        ),
    )
