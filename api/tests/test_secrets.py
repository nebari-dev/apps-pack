"""Write-only App secrets: values go to the App's own Secret, never to the CR or a response."""

from __future__ import annotations

import json

from .test_apps import make_app_body

URL = "/api/v1/apps"
SECRET = ("apps", "app-docs-site-secrets")


def launch(client, secrets=None, **runtime):
    body = make_app_body()
    if secrets is not None:
        body["secrets"] = secrets
    if runtime:
        body["runtime"] = runtime
    return client.post(URL, json=body)


def test_launch_with_secrets_stores_values_only_in_the_secret(client, store):
    resp = launch(client, {"API_KEY": "sk-live-123", "DATABASE_URL": "postgres://u:p@db/x"})
    assert resp.status_code == 201, resp.text
    assert "sk-live-123" not in resp.text
    assert resp.json()["runtime"]["secretKeys"] == ["API_KEY", "DATABASE_URL"]

    cr = store.apps[("apps", "docs-site")]
    assert cr["spec"]["runtime"]["secretKeys"] == ["API_KEY", "DATABASE_URL"]
    assert "sk-live-123" not in json.dumps(cr)
    assert "secrets" not in cr["spec"]

    secret = store.secrets[SECRET]
    assert secret["data"] == {"API_KEY": "sk-live-123", "DATABASE_URL": "postgres://u:p@db/x"}
    # Owned by the App, so it is garbage-collected with it.
    assert secret["owners"] == [
        {"apiVersion": "apps.nebari.dev/v1alpha1", "kind": "App", "name": "docs-site", "uid": "uid-apps-docs-site"}
    ]

    for path in ("", "/apps/docs-site", "/apps/docs-site/status"):
        assert "sk-live-123" not in client.get(URL + path).text


def test_launch_without_secrets_writes_no_secret(client, store):
    assert launch(client).status_code == 201
    assert store.secrets == {}
    assert "secretKeys" not in store.apps[("apps", "docs-site")]["spec"].get("runtime", {})


def test_caller_cannot_set_secret_keys_directly(client, store):
    """runtime.secretKeys follows the Secret: a list sent without values (which
    could name keys of a Secret the caller never wrote) is ignored.
    """
    resp = launch(client, secretKeys=["STOLEN"])
    assert resp.status_code == 201, resp.text
    assert "secretKeys" not in store.apps[("apps", "docs-site")]["spec"].get("runtime", {})
    resp = client.patch(f"{URL}/apps/docs-site", json={"runtime": {"secretKeys": ["STOLEN"]}})
    assert resp.status_code == 200, resp.text
    assert "secretKeys" not in store.apps[("apps", "docs-site")]["spec"]["runtime"]


def test_rotate_add_and_remove_through_patch(client, store):
    launch(client, {"API_KEY": "old", "TOKEN": "t"})
    resp = client.patch(f"{URL}/apps/docs-site", json={"secrets": {"API_KEY": "new", "TOKEN": None, "EXTRA": "e"}})
    assert resp.status_code == 200, resp.text
    assert resp.json()["runtime"]["secretKeys"] == ["API_KEY", "EXTRA"]
    assert "new" not in resp.text
    assert store.secrets[SECRET]["data"] == {"API_KEY": "new", "EXTRA": "e"}
    cr = store.apps[("apps", "docs-site")]
    # The version rolls the Deployment (the operator copies it to the pods).
    assert cr["metadata"]["annotations"]["apps.nebari.dev/secrets-version"] == store.secrets[SECRET]["version"]


def test_secrets_route(client, store):
    launch(client)
    resp = client.patch(f"{URL}/apps/docs-site/secrets", json={"API_KEY": "v1"})
    assert resp.status_code == 200, resp.text
    assert resp.json()["runtime"]["secretKeys"] == ["API_KEY"]
    first = store.apps[("apps", "docs-site")]["metadata"]["annotations"]["apps.nebari.dev/secrets-version"]

    resp = client.patch(f"{URL}/apps/docs-site/secrets", json={"API_KEY": "v2"})
    assert resp.status_code == 200
    second = store.apps[("apps", "docs-site")]["metadata"]["annotations"]["apps.nebari.dev/secrets-version"]
    assert first != second
    assert store.secrets[SECRET]["data"] == {"API_KEY": "v2"}

    resp = client.patch(f"{URL}/apps/docs-site/secrets", json={"API_KEY": None})
    assert resp.status_code == 200
    assert not resp.json()["runtime"].get("secretKeys")
    assert store.secrets[SECRET]["data"] == {}


def test_runtime_edit_keeps_secret_keys(client, store):
    launch(client, {"API_KEY": "v"})
    resp = client.patch(
        f"{URL}/apps/docs-site", json={"runtime": {"replicas": 2, "env": [{"name": "MODE", "value": "x"}]}}
    )
    assert resp.status_code == 200, resp.text
    assert store.apps[("apps", "docs-site")]["spec"]["runtime"]["secretKeys"] == ["API_KEY"]
    assert store.secret_writes == 1


def test_bad_keys_rejected(client, store):
    for key in ("API-KEY", "1ABC", "", "A" * 129):
        assert launch(client, {key: "v"}).status_code == 422, key
    assert launch(client, {f"K{i}": "v" for i in range(65)}).status_code == 422
    assert store.apps == {}
    assert client.post(URL, json=make_app_body()).status_code == 201
    assert client.patch(f"{URL}/apps/docs-site/secrets", json={"BAD-KEY": "v"}).status_code == 422
    assert store.secrets == {}


def test_too_many_keys_across_writes(client, store):
    launch(client, {f"K{i}": "v" for i in range(64)})
    resp = client.patch(f"{URL}/apps/docs-site/secrets", json={"ONE_MORE": "v"})
    assert resp.status_code == 422


def test_oversized_values_rejected(client, store):
    assert launch(client, {"BIG": "x" * (256 * 1024 + 1)}).status_code == 413
    assert store.apps == {}


def test_secret_and_env_of_the_same_name_rejected(client, store):
    resp = launch(client, {"API_KEY": "v"}, env=[{"name": "API_KEY", "value": "plain"}])
    assert resp.status_code == 422
    assert "API_KEY" in resp.json()["detail"]
    launch(client, {"API_KEY": "v"})
    resp = client.patch(f"{URL}/apps/docs-site", json={"runtime": {"env": [{"name": "API_KEY", "value": "x"}]}})
    assert resp.status_code == 422


def test_failed_secret_write_rolls_back_the_launch(client, store):
    store.fail_secret_writes = True
    resp = launch(client, {"API_KEY": "v"})
    assert resp.status_code == 502
    assert "v" not in resp.json()["detail"].split()
    assert store.apps == {}


def test_failed_secret_write_leaves_the_app_unchanged(client, store):
    launch(client)
    store.fail_secret_writes = True
    resp = client.patch(f"{URL}/apps/docs-site", json={"displayName": "New", "secrets": {"API_KEY": "v"}})
    assert resp.status_code == 502
    assert store.apps[("apps", "docs-site")]["spec"]["displayName"] == "Docs Site"


def test_conflict_retry_writes_the_secret_once(client, store):
    launch(client)
    store.conflicts = 1
    resp = client.patch(f"{URL}/apps/docs-site/secrets", json={"API_KEY": "v"})
    assert resp.status_code == 200, resp.text
    assert store.secret_writes == 1


def test_upload_launch_with_secrets(client, store):
    manifest = make_app_body()
    del manifest["source"]
    manifest["secrets"] = {"API_KEY": "sk"}
    resp = client.post(
        f"{URL}/upload",
        data={"manifest": json.dumps(manifest)},
        files={"file": ("index.html", b"<h1>hi</h1>", "text/html")},
    )
    assert resp.status_code == 201, resp.text
    assert resp.json()["runtime"]["secretKeys"] == ["API_KEY"]
    assert store.secrets[SECRET]["data"] == {"API_KEY": "sk"}


def secret_ref(secret: str) -> dict:
    return {"name": "STOLEN", "valueFrom": {"secretKeyRef": {"name": secret, "key": "API_KEY"}}}


def test_env_cannot_read_another_apps_secret(client, store):
    """runtime.env valueFrom is resolved by the kubelet, so naming another
    App's Secret would read it: refused on launch and on edit.
    """
    for ref in (secret_ref("app-victim-secrets"), secret_ref("db-credentials"), secret_ref("app-docs-site-secrets")):
        resp = launch(client, env=[ref])
        assert resp.status_code == 422, ref
        assert "secretKeyRef" in resp.json()["detail"]
    assert store.apps == {}

    assert launch(client).status_code == 201
    resp = client.patch(f"{URL}/apps/docs-site", json={"runtime": {"env": [secret_ref("app-victim-secrets")]}})
    assert resp.status_code == 422
    assert "env" not in store.apps[("apps", "docs-site")]["spec"].get("runtime", {})


def test_env_cannot_read_another_apps_configmaps(client, store):
    for cm in ("app-victim-content", "app-victim-server"):
        env = [{"name": "X", "valueFrom": {"configMapKeyRef": {"name": cm, "key": "f0000"}}}]
        resp = launch(client, env=env)
        assert resp.status_code == 422, cm
        assert cm in resp.json()["detail"]


def test_harmless_value_from_still_allowed(client, store):
    env = [
        {"name": "POD_IP", "valueFrom": {"fieldRef": {"fieldPath": "status.podIP"}}},
        {"name": "MEM", "valueFrom": {"resourceFieldRef": {"resource": "limits.memory"}}},
        {"name": "TEAM", "valueFrom": {"configMapKeyRef": {"name": "team-settings", "key": "k"}}},
        {"name": "OWN", "valueFrom": {"configMapKeyRef": {"name": "app-docs-site-content", "key": "k"}}},
    ]
    assert launch(client, env=env).status_code == 201
