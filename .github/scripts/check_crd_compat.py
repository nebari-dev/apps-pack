#!/usr/bin/env python3
"""Fail when a CRD change breaks objects already stored under a served version.

    check_crd_compat.py <base CRD> <new CRD>

The App CRD's versioning policy (docs: App CRD reference, "Versioning and
deprecation") allows only additive changes within a version. Breaking changes
fail the check:

- a served version stops being served or disappears;
- a property is removed, changes type, or loses x-kubernetes-preserve-unknown-fields;
- an existing property becomes required;
- an enum value is removed.

Tightened validation (bounds, patterns, new CEL rules) is reported as a
warning: Kubernetes validation ratcheting lets existing objects keep updating,
but the change still belongs in the upgrade notes.
"""

from __future__ import annotations

import sys
from typing import Any

import yaml

errors: list[str] = []
warnings: list[str] = []


def compare(path: str, old: dict[str, Any], new: dict[str, Any]) -> None:
    if old.get("type") != new.get("type"):
        errors.append(f"{path}: type changed from {old.get('type')!r} to {new.get('type')!r}")
        return
    if old.get("x-kubernetes-preserve-unknown-fields") and not new.get("x-kubernetes-preserve-unknown-fields"):
        errors.append(f"{path}: no longer preserves unknown fields")

    if "enum" in old:
        removed = [v for v in old["enum"] if v not in new.get("enum", old["enum"])]
        if removed:
            errors.append(f"{path}: enum values removed: {removed}")
    elif "enum" in new:
        warnings.append(f"{path}: now restricted to {new['enum']}")

    for key, tighter in (("minimum", max), ("minLength", max), ("minItems", max),
                         ("maximum", min), ("maxLength", min), ("maxItems", min)):
        if key in new and (key not in old or tighter(old[key], new[key]) != old[key]):
            warnings.append(f"{path}: {key} tightened to {new[key]} (was {old.get(key, 'unset')})")
    if new.get("pattern") and new.get("pattern") != old.get("pattern"):
        warnings.append(f"{path}: pattern changed to {new['pattern']!r}")
    old_rules = {r.get("rule") for r in old.get("x-kubernetes-validations", [])}
    for rule in new.get("x-kubernetes-validations", []):
        if rule.get("rule") not in old_rules:
            warnings.append(f"{path}: new validation rule {rule.get('rule')!r}")

    old_props, new_props = old.get("properties", {}), new.get("properties", {})
    for name, schema in old_props.items():
        if name not in new_props:
            errors.append(f"{path}.{name}: removed")
        else:
            compare(f"{path}.{name}", schema, new_props[name])
    newly_required = set(new.get("required", [])) - set(old.get("required", []))
    for name in sorted(newly_required & set(old_props)):
        errors.append(f"{path}.{name}: is now required")
    for name in sorted(newly_required - set(old_props)):
        errors.append(f"{path}.{name}: new field is required, so existing objects are invalid")

    if "items" in old and "items" in new:
        compare(f"{path}[]", old["items"], new["items"])
    if isinstance(old.get("additionalProperties"), dict) and isinstance(new.get("additionalProperties"), dict):
        compare(f"{path}{{}}", old["additionalProperties"], new["additionalProperties"])


def versions(crd: dict[str, Any]) -> dict[str, dict[str, Any]]:
    return {v["name"]: v for v in crd["spec"]["versions"]}


def main(base_path: str, new_path: str) -> int:
    with open(base_path) as f:
        base = yaml.safe_load(f)
    with open(new_path) as f:
        new = yaml.safe_load(f)
    base_versions, new_versions = versions(base), versions(new)
    for name, old in base_versions.items():
        if not old.get("served"):
            continue
        cur = new_versions.get(name)
        if cur is None or not cur.get("served"):
            errors.append(f"{name}: served version removed or no longer served")
            continue
        compare(name, old["schema"]["openAPIV3Schema"], cur["schema"]["openAPIV3Schema"])

    for w in warnings:
        print(f"::warning::CRD validation tightened (mention it in the upgrade notes): {w}")
    for e in errors:
        print(f"::error::Breaking CRD change: {e}")
    if errors:
        print("Breaking changes need a new API version; see 'Versioning and deprecation' in the App CRD reference.")
        return 1
    print(f"CRD is compatible ({len(warnings)} validation change(s) to note).")
    return 0


if __name__ == "__main__":
    sys.exit(main(*sys.argv[1:3]))
