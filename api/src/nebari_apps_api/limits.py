"""Request body size ceiling, enforced before any parsing.

Starlette buffers JSON bodies in memory and spools multipart uploads, so a
size check inside a route runs only after the whole body has arrived. This
middleware rejects an oversize request from its Content-Length header up
front, and counts bytes while the body streams in so a chunked request (no
Content-Length) cannot get past the ceiling either.
"""

from __future__ import annotations

import json
from collections.abc import Callable

from starlette.exceptions import HTTPException
from starlette.types import ASGIApp, Message, Receive, Scope, Send


def _detail(limit: int) -> str:
    return f"request body exceeds {limit} bytes - use a git or pvc source for larger apps"


class BodySizeLimitMiddleware:
    def __init__(self, app: ASGIApp, max_bytes: Callable[[], int]) -> None:
        self.app = app
        self.max_bytes = max_bytes

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        limit = self.max_bytes()
        for key, value in scope.get("headers", []):
            if key == b"content-length":
                try:
                    declared = int(value)
                except ValueError:
                    declared = 0
                if declared > limit:
                    await _send_413(send, limit)
                    return

        received = 0

        async def limited_receive() -> Message:
            nonlocal received
            message = await receive()
            if message["type"] == "http.request":
                received += len(message.get("body", b""))
                if received > limit:
                    # An HTTPException from inside body parsing is re-raised by
                    # FastAPI and rendered by the normal exception handler.
                    raise HTTPException(413, _detail(limit))
            return message

        await self.app(scope, limited_receive, send)


async def _send_413(send: Send, limit: int) -> None:
    body = json.dumps({"detail": _detail(limit)}).encode()
    await send(
        {
            "type": "http.response.start",
            "status": 413,
            "headers": [
                (b"content-type", b"application/json"),
                (b"content-length", str(len(body)).encode()),
                (b"connection", b"close"),
            ],
        }
    )
    await send({"type": "http.response.body", "body": body})
