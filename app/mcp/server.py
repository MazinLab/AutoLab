import json
import logging
import time
import uuid
from datetime import UTC, datetime
from typing import Any

from fastmcp import FastMCP
from sqlalchemy.engine import Connection, Engine
from sqlalchemy.exc import OperationalError
from sqlmodel import Session

from app.config import Settings
from app.mcp.annotation_tools import register_annotation_tools
from app.mcp.artifact_tools import register_artifact_tools
from app.mcp.project_tools import register_project_tools
from app.mcp.rf_tools import register_rf_tools
from app.mcp.write_tools import register_write_tools
from labcore.db import make_engine, readonly_connection
from labcore.events import list_events
from labcore.models.edges import RelationType
from labcore.schema_doc import describe_tables

logger = logging.getLogger(__name__)

# query_sql is row-bounded but must also be time- and byte-bounded: limit=1
# can still name an arbitrarily large value or an expensive recursive query.
_QUERY_DEADLINE_S: float = 5.0
_SQLITE_PROGRESS_OPS: int = 10_000
_MAX_CELL_CHARS: int = 10_000
_MAX_RESPONSE_CHARS: int = 200_000


def _install_query_deadline(connection: Connection) -> None:
    if connection.dialect.name == "sqlite":
        dbapi_connection = connection.connection.driver_connection
        deadline = time.monotonic() + _QUERY_DEADLINE_S

        def _over_deadline() -> bool:
            return time.monotonic() > deadline

        dbapi_connection.set_progress_handler(
            _over_deadline, _SQLITE_PROGRESS_OPS
        )
    elif connection.dialect.name == "postgresql":
        # SET LOCAL scopes the timeout to the read-only transaction that
        # readonly_connection already opened.
        connection.exec_driver_sql(
            f"SET LOCAL statement_timeout = {int(_QUERY_DEADLINE_S * 1000)}"
        )


def _clear_query_deadline(connection: Connection) -> None:
    if connection.dialect.name == "sqlite":
        connection.connection.driver_connection.set_progress_handler(None, 0)


def _bounded_cell(value: Any) -> Any:
    value = _json_safe(value)
    if isinstance(value, str) and len(value) > _MAX_CELL_CHARS:
        omitted = len(value) - _MAX_CELL_CHARS
        return value[:_MAX_CELL_CHARS] + f"... [truncated {omitted} chars]"
    return value


def _json_safe(value: Any) -> Any:
    try:
        json.dumps(value, allow_nan=False)
    except (TypeError, ValueError):
        return str(value)
    return value


def _decode_cursor(after: str) -> tuple[datetime, uuid.UUID]:
    try:
        at_raw, id_raw = after.split("|", 1)
        at = datetime.fromisoformat(at_raw)
        event_id = uuid.UUID(id_raw)
    except ValueError as exc:
        raise ValueError(f"malformed cursor: {after!r}") from exc
    if at.utcoffset() is None:
        raise ValueError(
            f"cursor timestamp must include a UTC offset: {after!r}"
        )
    return at.astimezone(UTC), event_id


def _encode_cursor(at: datetime, event_id: uuid.UUID) -> str:
    return f"{at.isoformat()}|{event_id}"


def _execute_query(
    connection: Connection, sql: str, fetch_limit: int
) -> tuple[list[str], list[Any]]:
    if connection.dialect.name == "postgresql":
        dbapi_connection = connection.connection.driver_connection
        with dbapi_connection.cursor() as cursor:
            # psycopg otherwise uses the simple query protocol for SQL without
            # parameters, which permits transaction-ending multi-statements.
            cursor.execute(sql, prepare=True)
            if cursor.description is None:
                raise ValueError("query_sql requires a statement that returns rows")
            columns = [column.name for column in cursor.description]
            rows = cursor.fetchmany(fetch_limit)
        return columns, rows

    result = connection.exec_driver_sql(sql)
    return list(result.keys()), result.fetchmany(fetch_limit)


def create_mcp(engine: Engine, settings: Settings) -> FastMCP:
    """Create the AutoLab MCP server bound to the application database."""
    mcp = FastMCP("AutoLab")
    query_engine = (
        make_engine(settings.readonly_db_url)
        if settings.readonly_db_url
        else engine
    )
    if engine.dialect.name == "postgresql" and not settings.readonly_db_url:
        logger.warning(
            "query_sql using primary credentials — configure "
            "AUTOLAB_READONLY_DB_URL"
        )

    @mcp.tool
    def describe_schema() -> dict[str, object]:
        """Describe catalog tables, columns, keys, and relation vocabulary."""
        return {
            "tables": describe_tables(dialect=engine.dialect),
            "relations": [relation.value for relation in RelationType],
        }

    @mcp.tool
    def query_sql(sql: str, limit: int = 50) -> dict[str, object]:
        """Run one database-enforced read-only SQL query against the catalog."""
        row_limit = min(max(limit, 0), 200)
        with readonly_connection(query_engine) as connection:
            _install_query_deadline(connection)
            try:
                columns, fetched_rows = _execute_query(
                    connection, sql, row_limit + 1
                )
            except OperationalError as exc:
                message = str(exc.orig or exc).lower()
                if "interrupt" in message or "statement timeout" in message:
                    raise ValueError(
                        f"query exceeded the {_QUERY_DEADLINE_S:g} s "
                        "execution budget"
                    ) from exc
                raise
            finally:
                _clear_query_deadline(connection)
        truncated = len(fetched_rows) > row_limit
        rows: list[list[Any]] = []
        response_chars = 0
        for row in fetched_rows[:row_limit]:
            cells = [_bounded_cell(value) for value in row]
            # Budget check BEFORE appending: one wide row of maximum-size
            # cells must not blow past the response ceiling on its way in.
            row_chars = len(json.dumps(cells, default=str))
            if response_chars + row_chars > _MAX_RESPONSE_CHARS:
                # Applies to the FIRST row too: a single row of maximum-size
                # cells must not blow past the response ceiling on its way in.
                truncated = True
                break
            response_chars += row_chars
            rows.append(cells)
        return {
            "columns": columns,
            "rows": rows,
            "row_count": len(rows),
            "truncated": truncated,
        }

    @mcp.tool
    def get_events(
        after: str | None = None,
        limit: int = 100,
        actions: str | None = None,
    ) -> dict[str, object]:
        """Return catalog events after an optional opaque pagination cursor.

        actions: optional comma-separated filter, e.g. "created,linked".
        """
        cursor = _decode_cursor(after) if after else None
        event_limit = min(max(limit, 0), 100)
        wanted = (
            {item.strip() for item in actions.split(",") if item.strip()}
            if actions
            else None
        )
        with Session(engine) as session:
            events = list_events(
                session, after=cursor, limit=event_limit, actions=wanted
            )
        next_cursor = (
            _encode_cursor(events[-1]["at"], events[-1]["id"])
            if events
            else None
        )
        return {
            "events": [
                {
                    key: value.isoformat()
                    if isinstance(value, datetime)
                    else _json_safe(value)
                    for key, value in event.items()
                }
                for event in events
            ],
            "next_cursor": next_cursor,
        }

    register_artifact_tools(mcp, engine, settings)
    register_annotation_tools(mcp, engine)
    register_write_tools(mcp, engine)
    register_project_tools(mcp, engine)
    register_rf_tools(mcp, engine)
    return mcp
