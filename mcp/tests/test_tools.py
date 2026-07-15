from __future__ import annotations

import json

from fastmcp import Client

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
    "framework": "static",
    "subdomain": "docs-site",
    "source_type": "inline",
    "inline_files": {"index.html": "<h1>hi</h1>"},
    "public": True,
}


async def test_tool_catalog():
    async with Client(mcp) as client:
        tools = {t.name for t in await client.list_tools()}
    assert tools == {
        "authenticate",
        "describe_cluster",
        "list_frameworks",
        "list_environments",
        "list_apps",
        "launch_app",
        "get_app",
        "get_app_status",
        "get_app_logs",
        "update_app",
        "stop_app",
        "start_app",
        "remove_app",
    }


async def test_describe_cluster():
    caps = await call("describe_cluster")
    assert caps["nebi"] is False
    assert "apps" in caps["namespaces"]
    assert "static" in caps["frameworks"]


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


async def test_launch_python_image(store):
    app = await call(
        "launch_app",
        {
            "name": "st-demo",
            "namespace": "apps",
            "display_name": "Streamlit Demo",
            "framework": "streamlit",
            "subdomain": "st-demo",
            "source_type": "image",
            "image_repository": "quay.io/org/st-demo",
            "image_tag": "v1",
            "env": {"LOG_LEVEL": "debug"},
            "groups": ["analysts"],
        },
    )
    assert app["framework"] == "streamlit"
    cr = store.apps[("apps", "st-demo")]
    assert cr["spec"]["source"]["image"]["repository"] == "quay.io/org/st-demo"
    assert {"name": "LOG_LEVEL", "value": "debug"} in cr["spec"]["runtime"]["env"]


async def test_launch_invalid_framework_source():
    result = await call(
        "launch_app",
        {**LAUNCH_ARGS, "framework": "streamlit", "source_type": "inline"},
    )
    assert result["status"] == 422
    assert "does not support" in result["error"]


async def test_stop_start_remove(store):
    await call("launch_app", LAUNCH_ARGS)

    await call("stop_app", {"namespace": "apps", "name": "docs-site"})
    assert store.apps[("apps", "docs-site")]["spec"]["runtime"]["replicas"] == 0

    await call("start_app", {"namespace": "apps", "name": "docs-site"})
    assert store.apps[("apps", "docs-site")]["spec"]["runtime"]["replicas"] == 1

    result = await call("remove_app", {"namespace": "apps", "name": "docs-site"})
    assert result["deleted"] == "apps/docs-site"
    assert store.apps == {}


async def test_logs_and_missing_app():
    await call("launch_app", LAUNCH_ARGS)
    logs = await call("get_app_logs", {"namespace": "apps", "name": "docs-site"})
    assert "hello" in logs["logs"]

    missing = await call("get_app", {"namespace": "apps", "name": "nope"})
    assert missing["status"] == 404


async def test_authenticate_reports_disabled():
    result = await call("authenticate")
    assert result["status"] == "not_required"
