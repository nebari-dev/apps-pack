from __future__ import annotations

import json

import pytest
from fastmcp import Client
from fastmcp.exceptions import ToolError

from nebari_apps_mcp.server import mcp


async def call(name: str, args: dict | None = None):
    async with Client(mcp) as client:
        result = await client.call_tool(name, args or {})
        if result.data is not None:
            return result.data
        # Bare JSON arrays have no structured-output schema; parse the text.
        return json.loads(result.content[0].text)


LAUNCH_ARGS = {
    "name": "docs-site",
    "namespace": "apps",
    "display_name": "Docs Site",
    "subdomain": "docs-site",
    "source_type": "inline",
    "inline_files": {"index.html": "<h1>hi</h1>"},
    "public": True,
}


async def test_tool_catalog():
    async with Client(mcp) as client:
        tools = {t.name for t in await client.list_tools()}
    assert tools == {
        "describe_cluster",
        "list_apps",
        "launch_app",
        "get_app",
        "get_app_status",
        "get_app_logs",
        "update_app",
        "stop_app",
        "start_app",
        "restart_app",
        "get_app_metrics",
        "remove_app",
    }


async def test_describe_cluster():
    caps = await call("describe_cluster")
    assert "apps" in caps["namespaces"]
    assert "inline" in caps["sourceTypes"]


async def test_launch_and_status_flow(store):
    app = await call("launch_app", LAUNCH_ARGS)
    assert app["name"] == "docs-site"
    assert app["status"]["phase"] == "Pending"
    assert ("apps", "docs-site") in store.apps

    status = await call("get_app_status", {"namespace": "apps", "name": "docs-site"})
    assert status["phase"] == "Pending"

    apps = await call("list_apps", {})
    assert len(apps) == 1


async def test_launch_is_idempotent(store):
    await call("launch_app", LAUNCH_ARGS)
    updated = await call("launch_app", {**LAUNCH_ARGS, "display_name": "Docs Site v2"})
    assert updated["displayName"] == "Docs Site v2"
    assert len(store.apps) == 1


async def test_launch_pixi_app(store):
    app = await call(
        "launch_app",
        {
            "name": "py-app",
            "namespace": "apps",
            "display_name": "Py App",
            "subdomain": "py-app",
            "source_type": "inline",
            "inline_files": {"pixi.toml": "[project]", "main.py": "print(1)"},
            "pixi_task": "start",
        },
    )
    assert app["runtime"]["pixiTask"] == "start"
    cr = store.apps[("apps", "py-app")]
    assert cr["spec"]["runtime"]["pixiTask"] == "start"


async def test_launch_git_source(store):
    app = await call(
        "launch_app",
        {
            "name": "git-site",
            "namespace": "apps",
            "display_name": "Git Site",
            "subdomain": "git-site",
            "source_type": "git",
            "git_url": "https://github.com/org/site",
            "git_ref": "v1.0",
            "git_subdir": "public",
            "env": {"LOG_LEVEL": "debug"},
            "groups": ["analysts"],
        },
    )
    assert app["source"]["type"] == "git"
    cr = store.apps[("apps", "git-site")]
    assert cr["spec"]["source"]["git"]["url"] == "https://github.com/org/site"
    assert {"name": "LOG_LEVEL", "value": "debug"} in cr["spec"]["runtime"]["env"]


async def test_launch_and_update_access_groups(store):
    await call("launch_app", {**LAUNCH_ARGS, "public": False, "groups": ["analysts"]})
    access = store.apps[("apps", "docs-site")]["spec"]["access"]
    assert access["groups"] == ["analysts"]
    assert "users" not in access

    await call(
        "update_app",
        {
            "namespace": "apps",
            "name": "docs-site",
            "patch": {"access": {"public": False, "groups": ["team"], "subdomain": "docs-site"}},
        },
    )
    access = store.apps[("apps", "docs-site")]["spec"]["access"]
    assert access["groups"] == ["team"]


async def test_launch_and_update_managers(store):
    await call("launch_app", {**LAUNCH_ARGS, "manager_users": ["bob"], "manager_groups": ["web-team"]})
    access = store.apps[("apps", "docs-site")]["spec"]["access"]
    assert access["managers"] == {"users": ["bob"], "groups": ["web-team"]}

    # Re-launching without manager args keeps the list.
    await call("launch_app", {**LAUNCH_ARGS, "display_name": "v2"})
    assert store.apps[("apps", "docs-site")]["spec"]["access"]["managers"]["users"] == ["bob"]

    await call(
        "update_app",
        {
            "namespace": "apps",
            "name": "docs-site",
            "patch": {"access": {"public": True, "subdomain": "docs-site", "managers": {"users": ["carol"]}}},
        },
    )
    assert store.apps[("apps", "docs-site")]["spec"]["access"]["managers"] == {"users": ["carol"]}


async def test_secrets_are_write_only(store):
    app = await call("launch_app", {**LAUNCH_ARGS, "secrets": {"API_KEY": "sk-live-123"}})
    assert app["runtime"]["secretKeys"] == ["API_KEY"]
    assert "sk-live-123" not in json.dumps(app)
    assert store.secrets[("apps", "app-docs-site-secrets")] == {"API_KEY": "sk-live-123"}
    assert "sk-live-123" not in json.dumps(store.apps[("apps", "docs-site")])

    # Re-launching without secrets keeps them; with secrets it rotates.
    await call("launch_app", {**LAUNCH_ARGS, "display_name": "v2"})
    assert store.apps[("apps", "docs-site")]["spec"]["runtime"]["secretKeys"] == ["API_KEY"]
    await call("launch_app", {**LAUNCH_ARGS, "secrets": {"API_KEY": "sk-live-456"}})
    assert store.secrets[("apps", "app-docs-site-secrets")] == {"API_KEY": "sk-live-456"}

    updated = await call(
        "update_app",
        {"namespace": "apps", "name": "docs-site", "patch": {"secrets": {"API_KEY": None, "TOKEN": "t0k"}}},
    )
    assert "t0k" not in json.dumps(updated)
    assert store.secrets[("apps", "app-docs-site-secrets")] == {"TOKEN": "t0k"}

    for tool, args in (
        ("get_app", {"namespace": "apps", "name": "docs-site"}),
        ("list_apps", {}),
        ("get_app_status", {"namespace": "apps", "name": "docs-site"}),
    ):
        out = json.dumps(await call(tool, args))
        assert "t0k" not in out and "sk-live" not in out, tool


async def test_stop_start_remove(store):
    await call("launch_app", LAUNCH_ARGS)

    await call("stop_app", {"namespace": "apps", "name": "docs-site"})
    assert store.apps[("apps", "docs-site")]["spec"]["runtime"]["replicas"] == 0

    await call("start_app", {"namespace": "apps", "name": "docs-site"})
    assert store.apps[("apps", "docs-site")]["spec"]["runtime"]["replicas"] == 1

    result = await call("remove_app", {"namespace": "apps", "name": "docs-site", "confirm": True})
    assert result["deleted"] == "apps/docs-site"
    assert store.apps == {}


async def test_restart(store):
    await call("launch_app", LAUNCH_ARGS)
    await call("restart_app", {"namespace": "apps", "name": "docs-site"})
    assert ("apps", "docs-site") in store.restarted


async def test_metrics(store):
    await call("launch_app", LAUNCH_ARGS)
    metrics = await call("get_app_metrics", {"namespace": "apps", "name": "docs-site"})
    assert metrics["available"] is True
    assert metrics["pods"][0]["cpu"] == "12m"
    assert metrics["pods"][0]["limits"] == {"cpu": "500m", "memory": "512Mi"}

    store.metrics_available = False
    unavailable = await call("get_app_metrics", {"namespace": "apps", "name": "docs-site"})
    assert unavailable["available"] is False
    # Pod health needs no metrics server.
    [pod] = unavailable["pods"]
    assert pod["cpu"] == ""
    assert pod["restarts"] == 3
    assert pod["lastTermination"]["reason"] == "OOMKilled"


async def test_logs_and_missing_app():
    await call("launch_app", LAUNCH_ARGS)
    logs = await call("get_app_logs", {"namespace": "apps", "name": "docs-site"})
    assert "hello" in logs["logs"]

    missing = await call("get_app", {"namespace": "apps", "name": "nope"})
    assert missing["status"] == 404


async def test_launch_landing_page_opt_in(store):
    app = await call("launch_app", LAUNCH_ARGS)
    assert app["landingPage"] is None  # cluster default

    app = await call("launch_app", {**LAUNCH_ARGS, "landing_page": True})
    assert app["landingPage"] == {"enabled": True}
    assert store.apps[("apps", "docs-site")]["spec"]["landingPage"] == {"enabled": True}


async def test_launch_idle_settings(store):
    await call("launch_app", LAUNCH_ARGS)
    runtime = store.apps[("apps", "docs-site")]["spec"]["runtime"]
    assert "keepAlive" not in runtime and "idleTimeoutMinutes" not in runtime  # cluster default

    await call("launch_app", {**LAUNCH_ARGS, "keep_alive": True, "idle_timeout_minutes": 45})
    runtime = store.apps[("apps", "docs-site")]["spec"]["runtime"]
    assert runtime["keepAlive"] is True
    assert runtime["idleTimeoutMinutes"] == 45


async def test_start_wakes_idle_app(store):
    await call("launch_app", LAUNCH_ARGS)
    store.apps[("apps", "docs-site")]["status"] = {"phase": "Idle"}
    await call("start_app", {"namespace": "apps", "name": "docs-site"})
    assert "apps.nebari.dev/wake-requested-at" in store.apps[("apps", "docs-site")]["metadata"]["annotations"]


async def test_launch_refuses_to_overwrite_another_users_app(store, monkeypatch):
    """With API authorization on, the 409 -> PATCH upsert must not take over
    an app someone else owns.
    """
    import httpx
    from nebari_apps_api.auth import User, current_user
    from nebari_apps_api.config import settings as api_settings
    from nebari_apps_api.main import create_app

    from nebari_apps_mcp import client as mcp_client

    who = {"user": User(username="alice")}
    api = create_app(store)
    api.dependency_overrides[current_user] = lambda: who["user"]
    monkeypatch.setattr(api_settings, "auth_enabled", True)
    monkeypatch.setattr(mcp_client, "transport", httpx.ASGITransport(app=api))

    await call("launch_app", LAUNCH_ARGS)
    assert store.apps[("apps", "docs-site")]["spec"]["owner"] == "alice"

    who["user"] = User(username="bob")
    result = await call("launch_app", {**LAUNCH_ARGS, "display_name": "Hijacked"})
    assert result["status"] == 403
    assert "another user" in result["error"]
    assert store.apps[("apps", "docs-site")]["spec"]["displayName"] == "Docs Site"

    # A manager may re-launch it, but not change who manages it.
    who["user"] = User(username="alice")
    await call("launch_app", {**LAUNCH_ARGS, "manager_users": ["carol"]})
    who["user"] = User(username="carol")
    relaunched = await call("launch_app", {**LAUNCH_ARGS, "display_name": "By Carol"})
    assert relaunched["displayName"] == "By Carol"
    assert relaunched["role"] == "manager"
    refused = await call("launch_app", {**LAUNCH_ARGS, "manager_users": ["carol", "bob"]})
    assert refused["status"] == 403
    assert "manages" in refused["error"]
    assert store.apps[("apps", "docs-site")]["spec"]["access"]["managers"] == {"users": ["carol"]}

    # The owner can still re-launch idempotently.
    who["user"] = User(username="alice")
    updated = await call("launch_app", {**LAUNCH_ARGS, "display_name": "Docs Site v2"})
    assert updated["displayName"] == "Docs Site v2"


async def test_launch_reports_taken_subdomain(store):
    await call("launch_app", LAUNCH_ARGS)
    result = await call("launch_app", {**LAUNCH_ARGS, "name": "other-site"})
    assert result["status"] == 409
    assert "subdomain" in result["error"]
    assert ("apps", "other-site") not in store.apps


async def test_launch_passes_resources(store):
    res = {"requests": {"cpu": "250m", "memory": "512Mi"}, "limits": {"memory": "1Gi"}}
    await call("launch_app", {**LAUNCH_ARGS, "resources": res})
    assert store.apps[("apps", "docs-site")]["spec"]["runtime"]["resources"] == res


async def test_launch_without_resources_leaves_defaults_to_operator(store):
    await call("launch_app", LAUNCH_ARGS)
    assert "resources" not in store.apps[("apps", "docs-site")]["spec"]["runtime"]


async def test_launch_over_the_inline_cap_is_413(store, monkeypatch):
    from nebari_apps_api.config import settings as api_settings

    monkeypatch.setattr(api_settings, "max_upload_bytes", 1000)
    result = await call("launch_app", {**LAUNCH_ARGS, "inline_files": {"index.html": "x" * 1001}})
    assert result["status"] == 413
    assert "1000-byte cap" in result["error"]
    assert ("apps", "docs-site") not in store.apps


async def test_secret_values_stay_out_of_tool_error_logs(caplog, capsys):
    with pytest.raises(ToolError):
        await call("launch_app", {**LAUNCH_ARGS, "secrets": {"API_KEY": ["sk-leak-999"]}})
    assert "tool call" in caplog.text
    out = capsys.readouterr()
    assert "sk-leak-999" not in caplog.text + out.out + out.err


@pytest.fixture
def images_allowed(store, monkeypatch):
    import httpx
    from nebari_apps_api.config import settings as api_settings
    from nebari_apps_api.main import create_app

    from nebari_apps_mcp import client as mcp_client

    monkeypatch.setattr(api_settings, "image_registries", ["ghcr.io/org"])
    monkeypatch.setattr(mcp_client, "transport", httpx.ASGITransport(app=create_app(store)))


IMAGE_ARGS = {
    "name": "dash",
    "namespace": "apps",
    "display_name": "Dash",
    "subdomain": "dash",
    "source_type": "image",
    "image_reference": "ghcr.io/org/dash:1.2.3",
    "image_port": 8501,
}


async def test_launch_image_app(store, images_allowed):
    caps = await call("describe_cluster")
    assert "image" in caps["sourceTypes"]
    assert caps["imageRegistries"] == ["ghcr.io/org"]
    app = await call(
        "launch_app",
        {**IMAGE_ARGS, "image_command": ["streamlit"], "image_args": ["run", "app.py"], "image_run_as_user": 1000},
    )
    assert app["source"]["type"] == "image"
    assert store.apps[("apps", "dash")]["spec"]["source"]["image"] == {
        "reference": "ghcr.io/org/dash:1.2.3",
        "port": 8501,
        "command": ["streamlit"],
        "args": ["run", "app.py"],
        "runAsUser": 1000,
    }


async def test_launch_image_outside_allowlist(store, images_allowed):
    out = await call("launch_app", {**IMAGE_ARGS, "image_reference": "ghcr.io/org-evil/dash:1"})
    assert out["status"] == 422
    assert "not in the allowed image registries" in out["error"]
    assert store.apps == {}


async def test_launch_image_when_disabled(store):
    caps = await call("describe_cluster")
    assert "image" not in caps["sourceTypes"]
    out = await call("launch_app", IMAGE_ARGS)
    assert out["status"] == 422
    assert "disabled" in out["error"]
