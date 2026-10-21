"""Convert between API models and App custom resource dicts."""

from __future__ import annotations

import re
from datetime import UTC, datetime
from typing import Any

from pydantic import BaseModel

from .k8s import GROUP, VERSION
from .models import AppCreate, AppOut, AppPatch, AppStatus, Role

API_VERSION = f"{GROUP}/{VERSION}"

# Set on an App to wake it from Idle (operator/api/v1alpha1 WakeAnnotation):
# an RFC 3339 time the operator counts as a request.
WAKE_ANNOTATION = "apps.nebari.dev/wake-requested-at"

# Set on an App to the resourceVersion of its Secret after every write
# (operator/api/v1alpha1 SecretsVersionAnnotation); the operator copies it to
# the pod template, so a rotated value rolls the Deployment.
SECRETS_VERSION_ANNOTATION = "apps.nebari.dev/secrets-version"


def secret_name(app_name: str) -> str:
    """The App's Secret (operator/api/v1alpha1 SecretName): derived from the
    App's name, never chosen by a caller.
    """
    return f"app-{app_name}-secrets"


def secret_keys(cr: dict[str, Any]) -> list[str]:
    return list(((cr.get("spec") or {}).get("runtime") or {}).get("secretKeys") or [])


def set_secret_keys(cr: dict[str, Any], keys: list[str]) -> None:
    runtime = cr.setdefault("spec", {}).setdefault("runtime", {})
    if keys:
        runtime["secretKeys"] = list(keys)
    else:
        runtime.pop("secretKeys", None)


def forbidden_env_ref(app_name: str, env: list[dict[str, Any]]) -> str | None:
    """Why runtime.env may not be stored, or None. Mirrors the operator's
    checkEnvRefs: the kubelet resolves valueFrom with its own rights, so a
    reference could read another App's data. No secretKeyRef at all (secrets
    go through `secrets`, into the App's own Secret), and no configMapKeyRef to
    a ConfigMap the operator generates for another App.
    """
    own = {f"app-{app_name}-content", f"app-{app_name}-server"}
    for entry in env:
        ref = entry.get("valueFrom") or {}
        name = entry.get("name", "")
        if "secretKeyRef" in ref:
            return (
                f"runtime.env {name}: valueFrom.secretKeyRef is not allowed; set the value in `secrets` "
                "instead (it is stored in the app's own Secret and never returned)"
            )
        cm = str((ref.get("configMapKeyRef") or {}).get("name", ""))
        if cm.startswith("app-") and cm.endswith(("-content", "-server")) and cm not in own:
            return f"runtime.env {name}: configMapKeyRef may not name {cm!r}, a ConfigMap of another app"
    return None


def env_names(cr: dict[str, Any]) -> set[str]:
    return {e.get("name", "") for e in ((cr.get("spec") or {}).get("runtime") or {}).get("env") or []}


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
        # secretKeys comes from the secrets the request carries, never from
        # the caller's runtime (the values go to the Secret, not here).
        "runtime": _clean(req.runtime.model_dump(exclude={"secretKeys"}))
        | ({"secretKeys": sorted(req.secrets)} if req.secrets else {}),
        "access": {
            "public": req.access.public,
            "groups": req.access.groups,
            "users": req.access.users,
            "managers": req.access.managers.model_dump() if req.access.managers else None,
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
        # secretKeys follows the Secret (main.py applies patch.secrets), so a
        # runtime edit keeps the stored list whatever it sends.
        keys = secret_keys(cr)
        spec["runtime"] = _merge(spec.get("runtime"), patch.runtime)
        set_secret_keys(cr, keys)
    if patch.access is not None:
        spec["access"] = _merge(spec.get("access"), patch.access) | {"public": patch.access.public}
    if patch.landingPage is not None:
        if patch.landingPage.enabled is None:
            spec.pop("landingPage", None)  # back to the cluster default
        else:
            spec["landingPage"] = {"enabled": patch.landingPage.enabled}
    return cr


def from_cr(cr: dict[str, Any], role: Role = "") -> AppOut:
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
        role=role,
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
