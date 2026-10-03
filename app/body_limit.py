"""Reject oversized upload bodies BEFORE multipart parsing spools them.

Starlette parses multipart (and spools file parts to temp storage) while
resolving endpoint parameters, so an in-handler size check runs too late to
protect disk/memory from a huge chunked body. This middleware wraps
``receive`` for the upload route and aborts the moment the raw body exceeds
the cap: a 413 if the app has not started responding, else a plain
disconnect. The in-handler counter stays as defense in depth.
"""

from __future__ import annotations

import json

# Multipart framing overhead beyond the file bytes themselves.
_FRAMING_ALLOWANCE = 1_048_576

_LIMITED_PATHS = frozenset({"/api/artifacts/upload"})


class UploadBodyLimitMiddleware:
    def __init__(self, app, max_bytes: int | None = None) -> None:
        self.app = app
        self.max_bytes = max_bytes

    def _limit(self, scope) -> int:
        if self.max_bytes is not None:
            return self.max_bytes + _FRAMING_ALLOWANCE
        settings = scope["app"].state.settings
        return settings.max_upload_bytes + _FRAMING_ALLOWANCE

    async def __call__(self, scope, receive, send) -> None:
        if scope["type"] != "http" or scope["path"] not in _LIMITED_PATHS:
            await self.app(scope, receive, send)
            return

        limit = self._limit(scope)
        received = 0
        response_started = False
        rejected = False

        async def limited_receive():
            nonlocal received, rejected
            message = await receive()
            if message["type"] == "http.request":
                received += len(message.get("body", b""))
                if received > limit and not rejected:
                    rejected = True
                    if not response_started:
                        await _send_413(send, limit)
                    # Starve the parser: it sees a disconnect and stops
                    # consuming instead of spooling the rest of the body.
                    return {"type": "http.disconnect"}
            return message

        async def tracking_send(message) -> None:
            nonlocal response_started
            if rejected:
                # We already answered 413; drop the app's late response.
                return
            if message["type"] == "http.response.start":
                response_started = True
            await send(message)

        await self.app(scope, limited_receive, tracking_send)


async def _send_413(send, limit: int) -> None:
    body = json.dumps(
        {"detail": f"request body exceeds {limit} bytes"}
    ).encode()
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
