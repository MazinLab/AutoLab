from __future__ import annotations

import asyncio

import pytest
from fastmcp import Client
from sqlalchemy.engine import Engine

from app.config import Settings
from app.mcp.server import create_mcp


def test_malformed_mcp_event_cursor_has_no_http_status(engine: Engine) -> None:
    async def call_get_events() -> None:
        async with Client(create_mcp(engine, Settings())) as client:
            await client.call_tool("get_events", {"after": "garbage"})

    with pytest.raises(Exception) as exc_info:
        asyncio.run(call_get_events())

    message = str(exc_info.value)
    assert "malformed cursor" in message
    assert "422" not in message
