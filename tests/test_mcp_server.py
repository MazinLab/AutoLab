import asyncio
import json

import pytest
from fastmcp import Client
from fastapi.testclient import TestClient
from sqlalchemy.engine import Engine
from sqlalchemy.exc import DBAPIError
from sqlmodel import Session

from app.config import Settings
from app.mcp.server import create_mcp
from labcore.db import readonly_connection
from labcore.schema_doc import describe_tables
from labcore.service import create_entity


def _call_mcp_tool(
    engine: Engine, tool_name: str, arguments: dict[str, object]
) -> dict[str, object]:
    async def call() -> dict[str, object]:
        async with Client(create_mcp(engine, Settings())) as client:
            return (await client.call_tool(tool_name, arguments)).data

    return asyncio.run(call())


def test_readonly_connection_blocks_writes_and_resets(engine: Engine) -> None:
    with readonly_connection(engine) as connection:
        assert connection.exec_driver_sql("SELECT 1").scalar_one() == 1
        with pytest.raises(DBAPIError, match=r"read.?only|not authorized"):
            connection.exec_driver_sql("CREATE TABLE forbidden (id INTEGER)")

    with engine.begin() as connection:
        connection.exec_driver_sql("CREATE TABLE allowed (id INTEGER)")
        connection.exec_driver_sql("DROP TABLE allowed")


def test_describe_tables_reports_metadata() -> None:
    tables = describe_tables()
    assert tables["entity_registry"]["doc"]
    wafer_columns = {
        column["name"]: column for column in tables["wafer"]["columns"]
    }
    assert {"id", "name", "diameter_mm"} <= wafer_columns.keys()
    assert wafer_columns["id"]["foreign_keys"] == ["entity_registry.id"]


def test_core_mcp_tools_and_registration_seams(engine: Engine) -> None:
    with Session(engine) as session:
        created = create_entity(session, "wafer", {"name": "MCP wafer"})
        session.commit()

    async def exercise_tools() -> None:
        mcp = create_mcp(engine, Settings())
        async with Client(mcp) as client:
            tools = {tool.name for tool in await client.list_tools()}
            assert {"describe_schema", "query_sql", "get_events"} <= tools

            schema = (await client.call_tool("describe_schema", {})).data
            assert "wafer" in schema["tables"]
            assert "derived_from" in schema["relations"]

            query = (
                await client.call_tool(
                    "query_sql",
                    {"sql": "SELECT name FROM wafer", "limit": 500},
                )
            ).data
            assert query == {
                "columns": ["name"],
                "rows": [["MCP wafer"]],
                "row_count": 1,
                "truncated": False,
            }

            events = (await client.call_tool("get_events", {})).data
            assert events["events"][0]["entity_id"] == str(created["id"])
            assert events["next_cursor"]

            with pytest.raises(Exception, match=r"read.?only|not authorized"):
                await client.call_tool(
                    "query_sql", {"sql": "DELETE FROM wafer"}
                )

    asyncio.run(exercise_tools())


def test_query_sql_caps_rows_and_reports_truncation(engine: Engine) -> None:
    with Session(engine) as session:
        for index in range(3):
            create_entity(session, "wafer", {"name": f"W{index}"})
        session.commit()

    limited = _call_mcp_tool(
        engine,
        "query_sql",
        {"sql": "SELECT name FROM wafer ORDER BY name", "limit": 1},
    )
    assert limited == {
        "columns": ["name"],
        "rows": [["W0"]],
        "row_count": 1,
        "truncated": True,
    }

    zero_limit = _call_mcp_tool(
        engine,
        "query_sql",
        {"sql": "SELECT name FROM wafer ORDER BY name", "limit": 0},
    )
    assert zero_limit == {
        "columns": ["name"],
        "rows": [],
        "row_count": 0,
        "truncated": True,
    }

    hard_cap = _call_mcp_tool(
        engine,
        "query_sql",
        {
            "sql": (
                "WITH RECURSIVE numbers(value) AS ("
                "SELECT 0 UNION ALL "
                "SELECT value + 1 FROM numbers WHERE value < 200) "
                "SELECT value FROM numbers ORDER BY value"
            ),
            "limit": 500,
        },
    )
    assert hard_cap["row_count"] == 200
    assert hard_cap["rows"][0] == [0]
    assert hard_cap["rows"][-1] == [199]
    assert hard_cap["truncated"] is True


def test_query_sql_aborts_over_time_budget(
    engine: Engine, monkeypatch: pytest.MonkeyPatch
) -> None:
    import app.mcp.server as server_module

    monkeypatch.setattr(server_module, "_QUERY_DEADLINE_S", 0.2)
    # SQLite reports the progress-handler abort ("execution budget");
    # Postgres enforces the same deadline via statement_timeout.
    with pytest.raises(
        Exception, match="execution budget|statement timeout"
    ):
        _call_mcp_tool(
            engine,
            "query_sql",
            {
                "sql": (
                    "WITH RECURSIVE endless(value) AS ("
                    "SELECT 0 UNION ALL SELECT value + 1 FROM endless) "
                    "SELECT max(value) FROM endless"
                ),
                "limit": 1,
            },
        )

    # the progress handler must be cleared: a normal query still works
    healthy = _call_mcp_tool(
        engine, "query_sql", {"sql": "SELECT 1", "limit": 1}
    )
    assert healthy["rows"] == [[1]]


def test_query_sql_truncates_oversized_cells(engine: Engine) -> None:
    big_cell_sql = (
        "SELECT repeat('0', 1200000)"
        if engine.dialect.name == "postgresql"
        else "SELECT hex(zeroblob(600000))"
    )
    result = _call_mcp_tool(
        engine,
        "query_sql",
        {"sql": big_cell_sql, "limit": 1},
    )
    cell = result["rows"][0][0]
    assert len(cell) < 11_000
    assert cell.endswith("chars]")


def test_get_events_rejects_naive_cursor_timestamp(engine: Engine) -> None:
    with pytest.raises(Exception, match="UTC offset"):
        _call_mcp_tool(
            engine,
            "get_events",
            {
                "after": (
                    "2026-07-19T00:00:00|"
                    "00000000-0000-0000-0000-000000000000"
                )
            },
        )


def test_get_events_paginates_after_opaque_cursor_without_repeats(
    engine: Engine,
) -> None:
    with Session(engine) as session:
        created = [
            create_entity(session, "wafer", {"name": f"W{index}"})
            for index in range(5)
        ]
        session.commit()

    pages: list[dict[str, object]] = []
    cursor: str | None = None
    while True:
        arguments: dict[str, object] = {"limit": 2}
        if cursor is not None:
            arguments["after"] = cursor
        page = _call_mcp_tool(engine, "get_events", arguments)
        pages.append(page)
        cursor = page["next_cursor"]
        if cursor is None:
            break

    event_ids = [
        str(event["entity_id"])
        for page in pages
        for event in page["events"]
    ]
    assert [len(page["events"]) for page in pages] == [2, 2, 1, 0]
    assert len(event_ids) == len(set(event_ids)) == 5
    assert set(event_ids) == {str(entity["id"]) for entity in created}


def test_mcp_http_mount_handshakes_and_preserves_rest_api(
    client: TestClient,
) -> None:
    headers = {
        "accept": "application/json, text/event-stream",
        "content-type": "application/json",
    }
    initialize = client.post(
        "/mcp",
        headers=headers,
        json={
            "jsonrpc": "2.0",
            "id": 1,
            "method": "initialize",
            "params": {
                "protocolVersion": "2025-06-18",
                "capabilities": {},
                "clientInfo": {"name": "pytest", "version": "1.0"},
            },
        },
    )
    assert initialize.status_code == 200
    message = json.loads(
        next(
            line.removeprefix("data: ")
            for line in initialize.text.splitlines()
            if line.startswith("data: ")
        )
    )
    assert message["result"]["serverInfo"]["name"] == "AutoLab"
    assert initialize.headers["mcp-session-id"]

    tools = client.post(
        "/mcp",
        headers=headers | {"mcp-session-id": initialize.headers["mcp-session-id"]},
        json={"jsonrpc": "2.0", "id": 2, "method": "tools/list", "params": {}},
    )
    assert tools.status_code == 200
    tools_message = json.loads(
        next(
            line.removeprefix("data: ")
            for line in tools.text.splitlines()
            if line.startswith("data: ")
        )
    )
    # Superset check: the mount must expose tools from every register_* group
    # (core, artifact, annotation, write) without pinning the full roster.
    assert {
        tool["name"] for tool in tools_message["result"]["tools"]
    } >= {"describe_schema", "read_document", "propose_annotation", "create_record"}

    assert client.get("/api/schema").status_code == 200


def test_readonly_connection_blocks_pragma_and_attach(engine: Engine) -> None:
    """query_only alone leaves PRAGMA state changes and ATTACH (arbitrary
    file creation) open; the authorizer must deny both."""
    if engine.dialect.name != "sqlite":
        pytest.skip(
            "exercises the SQLite authorizer; Postgres write blocking is "
            "covered by the read-only role tests"
        )
    with readonly_connection(engine) as connection:
        with pytest.raises(DBAPIError, match="not authorized"):
            connection.exec_driver_sql("PRAGMA journal_mode=OFF")
        with pytest.raises(DBAPIError, match="not authorized"):
            connection.exec_driver_sql(
                "ATTACH DATABASE '/tmp/autolab_evil_test.db' AS evil"
            )
        # plain reads still work under the authorizer
        rows = connection.exec_driver_sql(
            "SELECT count(*) FROM entity_registry"
        ).fetchall()
        assert rows == [(0,)]
    from pathlib import Path

    assert not Path("/tmp/autolab_evil_test.db").exists()
