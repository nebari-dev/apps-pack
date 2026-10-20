#!/usr/bin/env python3
"""Generate the UI's TypeScript types for the App resource from its CRD.

    python3 .github/scripts/gen_crd_types.py            # write ui/src/lib/crd.gen.ts
    python3 .github/scripts/gen_crd_types.py --check    # exit 1 if it is stale

The CRD (charts/nebari-apps/crds/apps.nebari.dev_apps.yaml, generated from
operator/api/ by controller-gen) is the source of truth for the App's shape.
ui/src/lib/types.ts derives its App types from this file; apps-api's Pydantic
models are checked against the same CRD by api/tests/test_crd_conformance.py.
"""

from __future__ import annotations

import sys
from pathlib import Path
from typing import Any

import yaml

ROOT = Path(__file__).resolve().parents[2]
CRD = ROOT / "charts/nebari-apps/crds/apps.nebari.dev_apps.yaml"
OUT = ROOT / "ui/src/lib/crd.gen.ts"

# Schema paths that get a named type; everything else is inlined.
NAMES = {
    "spec": "AppSpec",
    "spec.source": "AppSource",
    "spec.source.git": "GitSource",
    "spec.source.inline": "InlineSource",
    "spec.source.pvc": "PVCSource",
    "spec.runtime": "AppRuntime",
    "spec.runtime.env[]": "EnvVar",
    "spec.runtime.env[].valueFrom": "EnvVarSource",
    "spec.runtime.resources": "ResourceRequirements",
    "spec.access": "AppAccess",
    "spec.landingPage": "AppLandingPage",
    "status": "AppStatus",
    "status.replicas": "AppReplicas",
    "status.conditions[]": "AppCondition",
}

named: dict[str, str] = {}


def doc(schema: dict[str, Any], indent: str) -> str:
    text = " ".join((schema.get("description") or "").split())
    if not text:
        return ""
    # The first sentence is enough in an editor tooltip.
    first = text.split(". ")[0].rstrip(".")
    return f"{indent}/** {first}. */\n"


def ts_type(path: str, schema: dict[str, Any], indent: str) -> str:
    # spec and status are rendered as roots by render().
    if path in NAMES and path not in ("spec", "status"):
        name = NAMES[path]
        if name not in named:
            named[name] = ""  # reserve, so recursion cannot loop
            named[name] = object_body(path, schema, "")
        return name
    if schema.get("x-kubernetes-int-or-string"):
        return "number | string"
    if "enum" in schema:
        return " | ".join(f'"{v}"' for v in schema["enum"])
    t = schema.get("type")
    if t == "string":
        return "string"
    if t in ("integer", "number"):
        return "number"
    if t == "boolean":
        return "boolean"
    if t == "array":
        item = ts_type(path + "[]", schema.get("items", {}), indent)
        return f"({item})[]" if "|" in item else f"{item}[]"
    if t == "object":
        if "properties" in schema:
            return object_body(path, schema, indent)
        extra = schema.get("additionalProperties")
        if isinstance(extra, dict):
            return f"Record<string, {ts_type(path + '{}', extra, indent)}>"
        return "Record<string, unknown>"
    return "unknown"


def object_body(path: str, schema: dict[str, Any], indent: str) -> str:
    required = set(schema.get("required", []))
    inner = indent + "  "
    lines = ["{"]
    for key in sorted(schema.get("properties", {})):
        prop = schema["properties"][key]
        opt = "" if key in required else "?"
        lines.append(doc(prop, inner) + f"{inner}{key}{opt}: {ts_type(f'{path}.{key}', prop, inner)};")
    lines.append(indent + "}")
    return "\n".join(lines)


def render() -> str:
    crd = yaml.safe_load(CRD.read_text())
    version = next(v for v in crd["spec"]["versions"] if v.get("storage"))
    root = version["schema"]["openAPIV3Schema"]["properties"]
    for top in ("spec", "status"):
        named[NAMES[top]] = object_body(top, root[top], "")
    out = [
        "// Generated from charts/nebari-apps/crds/apps.nebari.dev_apps.yaml",
        f"// ({crd['spec']['group']}/{version['name']}) by .github/scripts/gen_crd_types.py.",
        "// Do not edit: change operator/api/, regenerate the CRD, then run the script.",
        "",
    ]
    for name in sorted(named):
        out.append(f"export type {name} = {named[name]};\n")
    return "\n".join(out)


def main() -> int:
    text = render()
    if "--check" in sys.argv:
        if not OUT.exists() or OUT.read_text() != text:
            print(f"::error::{OUT.relative_to(ROOT)} is stale; run python3 .github/scripts/gen_crd_types.py")
            return 1
        print(f"{OUT.relative_to(ROOT)} matches the CRD.")
        return 0
    OUT.write_text(text)
    return 0


if __name__ == "__main__":
    sys.exit(main())
