"""Structured JSON logs and request ids.

Every log line is one JSON object on stdout, including uvicorn's own.
RequestIdMiddleware gives each HTTP request an id - the caller's X-Request-ID
when it is well formed, otherwise a new one - binds it to every line logged
while the request is handled, echoes it on the response, and writes one access
line per request.
"""

from __future__ import annotations

import logging
import os
import re
import time
import uuid
from collections.abc import Iterable
from typing import Any

import structlog
from starlette.datastructures import MutableHeaders
from starlette.types import ASGIApp, Message, Receive, Scope, Send

REQUEST_ID_HEADER = "x-request-id"
_VALID_ID = re.compile(r"[A-Za-z0-9._:-]{1,128}")

log = structlog.get_logger("nebari_apps_api.access")


def configure_logging(level: str | None = None) -> None:
    """Route structlog and the stdlib (uvicorn included) through one JSON renderer."""
    shared: list[Any] = [
        structlog.contextvars.merge_contextvars,
        structlog.stdlib.add_log_level,
        structlog.stdlib.add_logger_name,
        structlog.processors.TimeStamper(fmt="iso", utc=True),
    ]
    structlog.configure(
        processors=[*shared, structlog.stdlib.ProcessorFormatter.wrap_for_formatter],
        logger_factory=structlog.stdlib.LoggerFactory(),
        wrapper_class=structlog.stdlib.BoundLogger,
        cache_logger_on_first_use=True,
    )
    handler = logging.StreamHandler()
    handler.setFormatter(
        structlog.stdlib.ProcessorFormatter(
            foreign_pre_chain=shared,
            processors=[
                structlog.stdlib.ProcessorFormatter.remove_processors_meta,
                structlog.processors.dict_tracebacks,
                structlog.processors.JSONRenderer(),
            ],
        )
    )
    root = logging.getLogger()
    root.handlers[:] = [handler]
    root.setLevel((level or os.environ.get("LOG_LEVEL", "INFO")).upper())
    for name in ("uvicorn", "uvicorn.error", "uvicorn.access"):
        logger = logging.getLogger(name)
        logger.handlers.clear()
        logger.propagate = True
    # RequestIdMiddleware writes the access line, with the request id.
    logging.getLogger("uvicorn.access").disabled = True


def request_id(value: str) -> str:
    """The caller's id if it is safe to log and forward, otherwise a new one."""
    return value if _VALID_ID.fullmatch(value) else uuid.uuid4().hex


class RequestIdMiddleware:
    def __init__(self, app: ASGIApp, quiet_paths: Iterable[str] = ()) -> None:
        self.app = app
        # Probe endpoints log at debug so they don't drown the access log.
        self.quiet_paths = frozenset(quiet_paths)

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        headers = [(k, v) for k, v in scope["headers"] if k != REQUEST_ID_HEADER.encode()]
        incoming = next((v for k, v in scope["headers"] if k == REQUEST_ID_HEADER.encode()), b"")
        rid = request_id(incoming.decode("latin-1"))
        # Handlers read the id from the request, which also reaches code that
        # runs outside this task (FastMCP tools).
        scope["headers"] = [*headers, (REQUEST_ID_HEADER.encode(), rid.encode())]
        structlog.contextvars.clear_contextvars()
        structlog.contextvars.bind_contextvars(request_id=rid)

        status = 500
        start = time.perf_counter()

        async def send_with_id(message: Message) -> None:
            nonlocal status
            if message["type"] == "http.response.start":
                status = message["status"]
                MutableHeaders(scope=message).append("X-Request-ID", rid)
            await send(message)

        try:
            await self.app(scope, receive, send_with_id)
        except Exception:
            log.exception("unhandled error", method=scope["method"], path=scope["path"])
            raise
        finally:
            log.log(
                logging.DEBUG if scope["path"] in self.quiet_paths else logging.INFO,
                "request",
                method=scope["method"],
                path=scope["path"],
                status=status,
                duration_ms=round((time.perf_counter() - start) * 1000, 1),
                user=scope.get("state", {}).get("user", ""),
            )
            structlog.contextvars.clear_contextvars()
