"""Assert the API's RBAC is namespaced in a chart render with allowedNamespaces set.

Usage: check_api_rbac.py <rendered.yaml> <namespace>...

With api.allowedNamespaces, App/pod access must come through a RoleBinding in
each listed namespace, and the only cluster-wide grants are read-only
namespaces and pods. Secrets are write-only everywhere: the API writes App
Secrets but must never be able to get, list or watch them.
"""

import sys

import yaml


def main(rendered: str, namespaces: list[str]) -> None:
    docs = [d for d in yaml.safe_load_all(open(rendered)) if d]
    crbs = [d for d in docs if d["kind"] == "ClusterRoleBinding" and d["roleRef"]["name"] == "test-nebari-apps-api"]
    assert not crbs, "API App/pod access must not be bound cluster-wide when allowedNamespaces is set"
    rbs = sorted(d["metadata"]["namespace"] for d in docs if d["kind"] == "RoleBinding" and d["roleRef"]["name"] == "test-nebari-apps-api")
    assert rbs == sorted(namespaces), rbs
    cluster = next(d for d in docs if d["kind"] == "ClusterRole" and d["metadata"]["name"] == "test-nebari-apps-api-cluster")
    assert {r["resources"][0] for r in cluster["rules"]} == {"namespaces", "pods"}, cluster["rules"]
    assert all(set(r["verbs"]) <= {"get", "list"} for r in cluster["rules"]), cluster["rules"]
    for role in (d for d in docs if d["kind"] in ("ClusterRole", "Role") and "nebari-apps-api" in d["metadata"]["name"]):
        for rule in role.get("rules") or []:
            if "secrets" in rule.get("resources", []):
                assert set(rule["verbs"]) <= {"create", "patch"}, (role["metadata"]["name"], rule)
    print("API RBAC scoped to", rbs)


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2:])
