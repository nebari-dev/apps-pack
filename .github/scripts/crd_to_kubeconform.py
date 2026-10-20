"""Convert the App CRD into the schema layout kubeconform looks up.

Usage: crd_to_kubeconform.py <schemas-dir>

Writes <schemas-dir>/<group>/<kind>_<version>.json for every version. The
apiserver silently prunes fields the CRD does not declare, so a typo in an
example would vanish; the schemas reject unknown fields instead.
"""

import json
import os
import sys

import yaml

CRD = "charts/nebari-apps/crds/apps.nebari.dev_apps.yaml"


def strict(node: object) -> None:
    if isinstance(node, dict):
        if "properties" in node and "additionalProperties" not in node and not node.get("x-kubernetes-preserve-unknown-fields"):
            node["additionalProperties"] = False
        for child in node.values():
            strict(child)
    elif isinstance(node, list):
        for child in node:
            strict(child)


def main(schemas: str) -> None:
    crd = yaml.safe_load(open(CRD))
    out = os.path.join(schemas, crd["spec"]["group"])
    os.makedirs(out, exist_ok=True)
    for v in crd["spec"]["versions"]:
        schema = v["schema"]["openAPIV3Schema"]
        strict(schema)
        name = f'{crd["spec"]["names"]["kind"].lower()}_{v["name"]}.json'
        with open(os.path.join(out, name), "w") as f:
            json.dump(schema, f)


if __name__ == "__main__":
    main(sys.argv[1])
