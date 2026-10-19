"""Prometheus metrics for apps-api.

Served at /metrics on the pod port. The UI's nginx proxies only /api/, so the
endpoint is reachable in-cluster (the chart's ServiceMonitor) but not through
the gateway. Labels use the matched route template, never the raw path, so
cardinality stays bounded however many Apps exist.
"""

from __future__ import annotations

import time

from prometheus_client import CONTENT_TYPE_LATEST, Counter, Histogram, generate_latest
from starlette.responses import Response
from starlette.types import ASGIApp, Message, Receive, Scope, Send

REQUESTS = Counter(
    "apps_api_requests_total",
    "HTTP requests handled, by method, route template and status code.",
    ["method", "route", "status"],
)
LATENCY = Histogram(
    "apps_api_request_duration_seconds",
    "HTTP request latency, by method and route template.",
    ["method", "route"],
    buckets=(0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30),
)

METRICS_PATH = "/metrics"


def route_of(scope: Scope) -> str:
    """The matched route's template (e.g. /api/v1/apps/{namespace}/{name})."""
    route = scope.get("route")
    path = getattr(route, "path", None)
    return path if isinstance(path, str) else "unmatched"


class MetricsMiddleware:
    """Counts and times every HTTP request except scrapes of /metrics."""

    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http" or scope["path"] == METRICS_PATH:
            await self.app(scope, receive, send)
            return

        status = 500
        start = time.perf_counter()

        async def send_status(message: Message) -> None:
            nonlocal status
            if message["type"] == "http.response.start":
                status = message["status"]
            await send(message)

        try:
            await self.app(scope, receive, send_status)
        finally:
            route = route_of(scope)
            REQUESTS.labels(scope["method"], route, str(status)).inc()
            LATENCY.labels(scope["method"], route).observe(time.perf_counter() - start)


def metrics_response() -> Response:
    return Response(generate_latest(), media_type=CONTENT_TYPE_LATEST)
